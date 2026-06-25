use crate::{run_local_process_with_env, ssh::CommandResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseEngine {
    Mysql,
    Sqlserver,
    Postgresql,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseAction {
    ListDatabases,
    ListTables,
    DescribeTable,
    PreviewTable,
    RunReadonlyQuery,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsDatabaseRequest {
    pub engine: DatabaseEngine,
    pub action: DatabaseAction,
    pub instance_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub sql: Option<String>,
    pub row_limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseMutationAction {
    InsertRow,
    UpdateRow,
    DeleteRow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowIdentityColumn {
    pub name: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowIdentity {
    pub columns: Vec<RowIdentityColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsDatabaseMutationRequest {
    pub engine: DatabaseEngine,
    pub action: DatabaseMutationAction,
    pub instance_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
    pub values: Option<serde_json::Value>,
    pub row_identity: Option<RowIdentity>,
    pub generated_columns: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DatabaseCommandPlan {
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

pub fn ensure_readonly_sql(engine: DatabaseEngine, sql: &str) -> Result<(), String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err("readonly SQL cannot be empty".to_string());
    }

    let normalized = trimmed.to_ascii_lowercase();
    if normalized.contains(';') {
        return Err("only readonly SQL is allowed".to_string());
    }

    let allowed = match engine {
        DatabaseEngine::Mysql => ["select", "show", "describe", "desc", "explain"].as_slice(),
        DatabaseEngine::Sqlserver => [
            "select",
            "exec sp_help",
            "exec sp_columns",
            "exec sp_tables",
            "with",
        ]
        .as_slice(),
        DatabaseEngine::Postgresql => ["select", "with", "explain"].as_slice(),
    };

    if !allowed.iter().any(|prefix| normalized.starts_with(prefix)) {
        return Err("only readonly SQL is allowed".to_string());
    }

    for denied in [
        "insert", "update", "delete", "drop", "alter", "create", "truncate", "replace", "merge",
        "grant", "revoke",
    ] {
        if contains_sql_keyword(&normalized, denied) {
            return Err("only readonly SQL is allowed".to_string());
        }
    }

    if (normalized.starts_with("select") && contains_sql_keyword(&normalized, "into"))
        || contains_sql_keyword(&normalized, "outfile")
        || contains_sql_keyword(&normalized, "dumpfile")
        || contains_sql_sequence(&normalized, &["into", "outfile"])
        || contains_sql_sequence(&normalized, &["into", "dumpfile"])
        || contains_sql_sequence(&normalized, &["copy", "to"])
        || contains_sql_sequence(&normalized, &["to", "program"])
    {
        return Err("only readonly SQL is allowed".to_string());
    }

    Ok(())
}

pub fn build_engine_command(
    engine: DatabaseEngine,
    action: DatabaseAction,
    instance_id: &str,
    database: Option<&str>,
    table: Option<&str>,
    sql: Option<&str>,
    row_limit: u32,
) -> Result<String, String> {
    let plan = build_engine_command_plan_with_schema(
        engine,
        action,
        instance_id,
        database,
        None,
        table,
        sql,
        row_limit,
    )?;
    Ok(render_command_plan(&plan))
}

pub fn build_engine_command_with_schema(
    engine: DatabaseEngine,
    action: DatabaseAction,
    instance_id: &str,
    database: Option<&str>,
    schema: Option<&str>,
    table: Option<&str>,
    sql: Option<&str>,
    row_limit: u32,
) -> Result<String, String> {
    let plan = build_engine_command_plan_with_schema(
        engine,
        action,
        instance_id,
        database,
        schema,
        table,
        sql,
        row_limit,
    )?;
    Ok(render_command_plan(&plan))
}

fn build_engine_command_plan_with_schema(
    engine: DatabaseEngine,
    action: DatabaseAction,
    instance_id: &str,
    database: Option<&str>,
    schema: Option<&str>,
    table: Option<&str>,
    sql: Option<&str>,
    row_limit: u32,
) -> Result<DatabaseCommandPlan, String> {
    let bounded_limit = row_limit.clamp(1, 100);
    let instance_target = parse_instance_target(engine, instance_id)?;
    let database = database.unwrap_or_default();
    let schema = schema.unwrap_or(match engine {
        DatabaseEngine::Sqlserver => "dbo",
        DatabaseEngine::Postgresql => "public",
        DatabaseEngine::Mysql => "",
    });
    let table = table.unwrap_or_default();
    let sql = sql.unwrap_or_default().trim();

    let query = match (engine, action) {
        (DatabaseEngine::Mysql, DatabaseAction::ListDatabases) => "SHOW DATABASES;".to_string(),
        (DatabaseEngine::Mysql, DatabaseAction::ListTables) => {
            if database.is_empty() {
                return Err("database is required".to_string());
            }
            format!("SHOW TABLES FROM `{}`;", escape_mysql_identifier(database))
        }
        (DatabaseEngine::Mysql, DatabaseAction::DescribeTable) => {
            if database.is_empty() || table.is_empty() {
                return Err("database and table are required".to_string());
            }
            format!(
                "DESCRIBE `{}`.`{}`;",
                escape_mysql_identifier(database),
                escape_mysql_identifier(table)
            )
        }
        (DatabaseEngine::Mysql, DatabaseAction::PreviewTable) => {
            if database.is_empty() || table.is_empty() {
                return Err("database and table are required".to_string());
            }
            format!(
                "SELECT * FROM `{}`.`{}` LIMIT {};",
                escape_mysql_identifier(database),
                escape_mysql_identifier(table),
                bounded_limit
            )
        }
        (DatabaseEngine::Mysql, DatabaseAction::RunReadonlyQuery) => {
            if database.is_empty() {
                return Err("database is required".to_string());
            }
            if sql.is_empty() {
                return Err("sql is required".to_string());
            }
            sql.to_string()
        }
        (DatabaseEngine::Sqlserver, DatabaseAction::ListDatabases) => {
            "SELECT name FROM sys.databases ORDER BY name;".to_string()
        }
        (DatabaseEngine::Sqlserver, DatabaseAction::ListTables) => {
            if database.is_empty() {
                return Err("database is required".to_string());
            }
            format!(
                "EXEC sp_tables @table_owner = N'{}';",
                escape_sql_literal(schema)
            )
        }
        (DatabaseEngine::Sqlserver, DatabaseAction::DescribeTable) => {
            if database.is_empty() || table.is_empty() {
                return Err("database and table are required".to_string());
            }
            format!(
                "EXEC sp_columns @table_name = N'{}', @table_owner = N'{}';",
                escape_sql_literal(table),
                escape_sql_literal(schema)
            )
        }
        (DatabaseEngine::Sqlserver, DatabaseAction::PreviewTable) => {
            if database.is_empty() || table.is_empty() {
                return Err("database and table are required".to_string());
            }
            format!(
                "SELECT TOP {} * FROM [{}].[{}].[{}];",
                bounded_limit,
                escape_sqlserver_identifier(database),
                escape_sqlserver_identifier(schema),
                escape_sqlserver_identifier(table)
            )
        }
        (DatabaseEngine::Sqlserver, DatabaseAction::RunReadonlyQuery) => {
            if sql.is_empty() {
                return Err("sql is required".to_string());
            }
            sql.to_string()
        }
        (DatabaseEngine::Postgresql, DatabaseAction::ListDatabases) => {
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;"
                .to_string()
        }
        (DatabaseEngine::Postgresql, DatabaseAction::ListTables) => format!(
            "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = '{}' AND current_database() = '{}' ORDER BY tablename;",
            escape_sql_literal(schema),
            escape_sql_literal(required_database(database)?)
        ),
        (DatabaseEngine::Postgresql, DatabaseAction::DescribeTable) => {
            if database.is_empty() || table.is_empty() {
                return Err("database and table are required".to_string());
            }
            format!("\\d {}.{}", escape_psql_identifier(schema), escape_psql_identifier(table))
        }
        (DatabaseEngine::Postgresql, DatabaseAction::PreviewTable) => {
            if database.is_empty() || table.is_empty() {
                return Err("database and table are required".to_string());
            }
            format!(
                "SELECT * FROM {}.{} LIMIT {};",
                escape_psql_identifier(schema),
                escape_psql_identifier(table),
                bounded_limit
            )
        }
        (DatabaseEngine::Postgresql, DatabaseAction::RunReadonlyQuery) => {
            if sql.is_empty() {
                return Err("sql is required".to_string());
            }
            sql.to_string()
        }
    };

    Ok(match engine {
        DatabaseEngine::Mysql => DatabaseCommandPlan {
            program: "mysql".to_string(),
            args: build_mysql_args(instance_target, database, &query),
            env: Vec::new(),
        },
        DatabaseEngine::Sqlserver => DatabaseCommandPlan {
            program: "sqlcmd".to_string(),
            args: build_sqlserver_args(
                &sqlserver_server_arg(instance_target),
                database,
                &with_sqlserver_no_count(&query),
            ),
            env: Vec::new(),
        },
        DatabaseEngine::Postgresql => DatabaseCommandPlan {
            program: "psql".to_string(),
            args: build_postgresql_args(instance_target, database, &query),
            env: vec![("PGCLIENTENCODING".to_string(), "UTF8".to_string())],
        },
    })
}

#[tauri::command]
pub async fn windows_database_readonly(request: WindowsDatabaseRequest) -> CommandResult {
    let row_limit = request.row_limit.unwrap_or(50);

    if matches!(request.action, DatabaseAction::RunReadonlyQuery) {
        let Some(sql) = request.sql.as_deref() else {
            return command_error("sql is required");
        };
        if let Err(err) = ensure_readonly_sql(request.engine, sql) {
            return command_error(&err);
        }
    }

    let plan = match build_engine_command_plan_with_schema(
        request.engine,
        request.action,
        &request.instance_id,
        request.database.as_deref(),
        request.schema.as_deref(),
        request.table.as_deref(),
        request.sql.as_deref(),
        row_limit,
    ) {
        Ok(plan) => plan,
        Err(err) => return command_error(&err),
    };

    run_local_process_with_env(&plan.program, &plan.args, &plan.env)
}

#[tauri::command]
pub async fn windows_database_mutation(request: WindowsDatabaseMutationRequest) -> CommandResult {
    let plan = match build_mutation_command_plan(&request) {
        Ok(plan) => plan,
        Err(err) => return command_error(&err),
    };

    run_local_process_with_env(&plan.program, &plan.args, &plan.env)
}

fn command_error(message: &str) -> CommandResult {
    CommandResult {
        success: false,
        stdout: String::new(),
        stderr: message.to_string(),
        exit_code: -1,
    }
}

fn build_mysql_args(instance_target: &str, database: &str, query: &str) -> Vec<String> {
    let mut args = vec![
        "--batch".to_string(),
        "--raw".to_string(),
        "--skip-column-names".to_string(),
        "--default-character-set=utf8mb4".to_string(),
    ];
    let (host, port) = parse_network_instance_target(instance_target);
    args.push("--host".to_string());
    args.push(host);
    if let Some(port) = port {
        args.push("--port".to_string());
        args.push(port);
    }
    if !database.is_empty() {
        args.push("--database".to_string());
        args.push(database.to_string());
    }
    args.push("-e".to_string());
    args.push(query.to_string());
    args
}

fn build_sqlserver_args(server: &str, database: &str, query: &str) -> Vec<String> {
    let mut args = vec![
        "-S".to_string(),
        server.to_string(),
        "-W".to_string(),
        "-s".to_string(),
        ",".to_string(),
        "-f".to_string(),
        "65001".to_string(),
    ];
    if !database.is_empty() {
        args.push("-d".to_string());
        args.push(database.to_string());
    }
    args.push("-Q".to_string());
    args.push(query.to_string());
    args
}

fn with_sqlserver_no_count(query: &str) -> String {
    let trimmed = query.trim_start();
    if trimmed.to_ascii_lowercase().starts_with("set nocount on") {
        query.to_string()
    } else {
        format!("SET NOCOUNT ON; {}", query)
    }
}

fn build_postgresql_args(instance_target: &str, database: &str, query: &str) -> Vec<String> {
    let mut args = Vec::new();
    let (host, port) = parse_network_instance_target(instance_target);
    args.push("-h".to_string());
    args.push(host);
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port);
    }
    if !database.is_empty() {
        args.push("-d".to_string());
        args.push(database.to_string());
    }
    args.push("-At".to_string());
    args.push("-F".to_string());
    args.push(",".to_string());
    args.push("-c".to_string());
    args.push(query.to_string());
    args
}

fn escape_mysql_identifier(value: &str) -> String {
    value.replace('`', "``")
}

fn escape_psql_identifier(value: &str) -> String {
    value.replace('"', "\"\"")
}

fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn escape_sqlserver_identifier(value: &str) -> String {
    value.replace(']', "]]")
}

fn escape_double_quoted_argument(value: &str) -> String {
    value.replace('"', "\\\"")
}

fn render_command_plan(plan: &DatabaseCommandPlan) -> String {
    let rendered_args = plan
        .args
        .iter()
        .map(|arg| {
            if arg.contains(' ') || arg.contains('"') || arg.contains(',') || arg.contains('\\') {
                format!("\"{}\"", escape_double_quoted_argument(arg))
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if rendered_args.is_empty() {
        plan.program.clone()
    } else {
        format!("{} {}", plan.program, rendered_args)
    }
}

fn parse_instance_target(engine: DatabaseEngine, instance_id: &str) -> Result<&str, String> {
    let (prefix, target) = instance_id
        .split_once(':')
        .ok_or_else(|| "instance_id must be in <engine>:<target> format".to_string())?;
    let expected_prefix = match engine {
        DatabaseEngine::Mysql => "mysql",
        DatabaseEngine::Sqlserver => "sqlserver",
        DatabaseEngine::Postgresql => "postgresql",
    };

    if prefix != expected_prefix || target.trim().is_empty() {
        return Err("instance_id does not match engine".to_string());
    }

    Ok(target.trim())
}

fn sqlserver_server_arg(instance_target: &str) -> String {
    if instance_target.eq_ignore_ascii_case("MSSQLSERVER") {
        return "localhost".to_string();
    }

    let instance_name = instance_target
        .strip_prefix("MSSQL$")
        .unwrap_or(instance_target)
        .trim();
    format!("localhost\\{}", instance_name)
}

fn parse_network_instance_target(instance_target: &str) -> (String, Option<String>) {
    if let Some((host, port)) = instance_target.rsplit_once(':') {
        if !host.trim().is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
            return (host.trim().to_string(), Some(port.trim().to_string()));
        }
    }

    (instance_target.trim().to_string(), None)
}

fn required_database(database: &str) -> Result<&str, String> {
    if database.is_empty() {
        Err("database is required".to_string())
    } else {
        Ok(database)
    }
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
    {
        return Err("unsafe identifier".to_string());
    }

    Ok(())
}

fn values_object(
    value: &Option<serde_json::Value>,
) -> Result<Vec<(String, serde_json::Value)>, String> {
    let Some(serde_json::Value::Object(values)) = value else {
        return Err("values are required".to_string());
    };

    if values.is_empty() {
        return Err("values are required".to_string());
    }

    values
        .iter()
        .map(|(name, value)| {
            validate_identifier(name)?;
            Ok((name.clone(), value.clone()))
        })
        .collect()
}

fn filtered_values(
    values: &Option<serde_json::Value>,
    generated_columns: &Option<Vec<String>>,
) -> Result<Vec<(String, serde_json::Value)>, String> {
    let generated = generated_columns
        .as_ref()
        .map(|items| {
            items
                .iter()
                .map(|item| item.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let filtered = values_object(values)?
        .into_iter()
        .filter(|(name, _)| {
            !generated
                .iter()
                .any(|generated_name| generated_name == &name.to_ascii_lowercase())
        })
        .collect::<Vec<_>>();

    if filtered.is_empty() {
        return Err("values are required".to_string());
    }

    Ok(filtered)
}

fn render_sql_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(value) => {
            if *value {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => format!("'{}'", escape_sql_literal(value)),
        other => format!("'{}'", escape_sql_literal(&other.to_string())),
    }
}

fn quote_identifier(engine: DatabaseEngine, value: &str) -> String {
    match engine {
        DatabaseEngine::Mysql => format!("`{}`", escape_mysql_identifier(value)),
        DatabaseEngine::Sqlserver => format!("[{}]", escape_sqlserver_identifier(value)),
        DatabaseEngine::Postgresql => escape_psql_identifier(value),
    }
}

fn mutation_where_clause(engine: DatabaseEngine, identity: &RowIdentity) -> Result<String, String> {
    if identity.columns.is_empty() {
        return Err("row identity is required".to_string());
    }

    identity
        .columns
        .iter()
        .map(|column| {
            validate_identifier(&column.name)?;
            Ok(format!(
                "{} = {}",
                quote_identifier(engine, &column.name),
                render_sql_literal(&column.value)
            ))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join(" AND "))
}

fn qualified_mutation_table(
    engine: DatabaseEngine,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    validate_identifier(table)?;
    if !schema.is_empty() {
        validate_identifier(schema)?;
    }

    Ok(match engine {
        DatabaseEngine::Mysql => quote_identifier(engine, table),
        DatabaseEngine::Sqlserver | DatabaseEngine::Postgresql => {
            format!(
                "{}.{}",
                quote_identifier(engine, schema),
                quote_identifier(engine, table)
            )
        }
    })
}

fn build_mutation_sql(request: &WindowsDatabaseMutationRequest) -> Result<String, String> {
    validate_identifier(&request.database)?;
    validate_identifier(&request.table)?;
    if let Some(schema) = request.schema.as_deref() {
        validate_identifier(schema)?;
    }

    let schema = request.schema.as_deref().unwrap_or(match request.engine {
        DatabaseEngine::Sqlserver => "dbo",
        DatabaseEngine::Postgresql => "public",
        DatabaseEngine::Mysql => "",
    });
    let table = qualified_mutation_table(request.engine, schema, &request.table)?;

    match request.action {
        DatabaseMutationAction::InsertRow => {
            let values = filtered_values(&request.values, &request.generated_columns)?;
            let columns = values
                .iter()
                .map(|(name, _)| quote_identifier(request.engine, name))
                .collect::<Vec<_>>()
                .join(", ");
            let literals = values
                .iter()
                .map(|(_, value)| render_sql_literal(value))
                .collect::<Vec<_>>()
                .join(", ");

            Ok(format!(
                "INSERT INTO {} ({}) VALUES ({});",
                table, columns, literals
            ))
        }
        DatabaseMutationAction::UpdateRow => {
            let identity = request
                .row_identity
                .as_ref()
                .ok_or_else(|| "row identity is required".to_string())?;
            let values = filtered_values(&request.values, &request.generated_columns)?;
            let assignments = values
                .iter()
                .map(|(name, value)| {
                    Ok(format!(
                        "{} = {}",
                        quote_identifier(request.engine, name),
                        render_sql_literal(value)
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .join(", ");
            let where_clause = mutation_where_clause(request.engine, identity)?;

            match request.engine {
                DatabaseEngine::Mysql => Ok(format!(
                    "UPDATE {} SET {} WHERE {} LIMIT 1;",
                    table, assignments, where_clause
                )),
                DatabaseEngine::Sqlserver => Ok(format!(
                    "UPDATE TOP (1) {} SET {} WHERE {};",
                    table, assignments, where_clause
                )),
                DatabaseEngine::Postgresql => Ok(format!(
                    "WITH target AS (SELECT 1 FROM {} WHERE {} LIMIT 1) UPDATE {} SET {} WHERE {} RETURNING 1;",
                    table, where_clause, table, assignments, where_clause
                )),
            }
        }
        DatabaseMutationAction::DeleteRow => {
            let identity = request
                .row_identity
                .as_ref()
                .ok_or_else(|| "row identity is required".to_string())?;
            let where_clause = mutation_where_clause(request.engine, identity)?;

            match request.engine {
                DatabaseEngine::Mysql => Ok(format!(
                    "DELETE FROM {} WHERE {} LIMIT 1;",
                    table, where_clause
                )),
                DatabaseEngine::Sqlserver => Ok(format!(
                    "DELETE TOP (1) FROM {} WHERE {};",
                    table, where_clause
                )),
                DatabaseEngine::Postgresql => Ok(format!(
                    "WITH target AS (SELECT 1 FROM {} WHERE {} LIMIT 1) DELETE FROM {} WHERE {} RETURNING 1;",
                    table, where_clause, table, where_clause
                )),
            }
        }
    }
}

fn build_mutation_command_plan(
    request: &WindowsDatabaseMutationRequest,
) -> Result<DatabaseCommandPlan, String> {
    let sql = build_mutation_sql(request)?;
    let instance_target = parse_instance_target(request.engine, &request.instance_id)?;

    Ok(match request.engine {
        DatabaseEngine::Mysql => DatabaseCommandPlan {
            program: "mysql".to_string(),
            args: build_mysql_args(instance_target, &request.database, &sql),
            env: Vec::new(),
        },
        DatabaseEngine::Sqlserver => DatabaseCommandPlan {
            program: "sqlcmd".to_string(),
            args: build_sqlserver_args(
                &sqlserver_server_arg(instance_target),
                &request.database,
                &with_sqlserver_no_count(&sql),
            ),
            env: Vec::new(),
        },
        DatabaseEngine::Postgresql => DatabaseCommandPlan {
            program: "psql".to_string(),
            args: build_postgresql_args(instance_target, &request.database, &sql),
            env: vec![("PGCLIENTENCODING".to_string(), "UTF8".to_string())],
        },
    })
}

fn contains_sql_keyword(sql: &str, keyword: &str) -> bool {
    sql.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .any(|token| token == keyword)
}

fn contains_sql_sequence(sql: &str, sequence: &[&str]) -> bool {
    let tokens: Vec<&str> = sql
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .filter(|token| !token.is_empty())
        .collect();

    tokens
        .windows(sequence.len())
        .any(|window| window.iter().copied().eq(sequence.iter().copied()))
}

#[cfg(test)]
mod tests {
    use super::{
        build_engine_command, build_engine_command_plan_with_schema,
        build_engine_command_with_schema, build_mutation_command_plan, ensure_readonly_sql,
        DatabaseAction, DatabaseEngine, DatabaseMutationAction, RowIdentity, RowIdentityColumn,
        WindowsDatabaseMutationRequest, WindowsDatabaseRequest,
    };
    use serde_json::json;

    #[test]
    fn rejects_non_readonly_sql() {
        let error = ensure_readonly_sql(DatabaseEngine::Mysql, "DELETE FROM users").unwrap_err();

        assert!(error.to_lowercase().contains("readonly"));
    }

    #[test]
    fn rejects_multi_statement_write_sql() {
        let error =
            ensure_readonly_sql(DatabaseEngine::Mysql, "SELECT 1; DELETE FROM users").unwrap_err();

        assert!(error.to_lowercase().contains("readonly"));
    }

    #[test]
    fn rejects_select_into_sql() {
        let error = ensure_readonly_sql(
            DatabaseEngine::Sqlserver,
            "SELECT * INTO archive_users FROM users",
        )
        .unwrap_err();

        assert!(error.to_lowercase().contains("readonly"));
    }

    #[test]
    fn rejects_select_with_non_adjacent_into_sql() {
        let error = ensure_readonly_sql(
            DatabaseEngine::Sqlserver,
            "SELECT id, email INTO archive_users FROM users",
        )
        .unwrap_err();

        assert!(error.to_lowercase().contains("readonly"));
    }

    #[test]
    fn rejects_into_outfile_sql() {
        let error = ensure_readonly_sql(
            DatabaseEngine::Mysql,
            "SELECT * FROM users INTO OUTFILE '/tmp/users.csv'",
        )
        .unwrap_err();

        assert!(error.to_lowercase().contains("readonly"));
    }

    #[test]
    fn builds_mysql_preview_command() {
        let command = build_engine_command(
            DatabaseEngine::Mysql,
            DatabaseAction::PreviewTable,
            "mysql:MySQL80",
            Some("appdb"),
            Some("users"),
            None,
            50,
        )
        .unwrap();

        assert!(command.contains("SELECT *"));
        assert!(command.contains("LIMIT 50"));
    }

    #[test]
    fn caps_preview_row_limit_to_100() {
        let command = build_engine_command(
            DatabaseEngine::Mysql,
            DatabaseAction::PreviewTable,
            "mysql:MySQL80",
            Some("appdb"),
            Some("users"),
            None,
            500,
        )
        .unwrap();

        assert!(command.contains("LIMIT 100"));
    }

    #[test]
    fn rejects_sqlserver_preview_without_database() {
        let error = build_engine_command(
            DatabaseEngine::Sqlserver,
            DatabaseAction::PreviewTable,
            "sqlserver:MSSQLSERVER",
            None,
            Some("users"),
            None,
            50,
        )
        .unwrap_err();

        assert!(error.contains("database"));
    }

    #[test]
    fn rejects_mismatched_instance_id_prefix() {
        let error = build_engine_command(
            DatabaseEngine::Mysql,
            DatabaseAction::ListDatabases,
            "sqlserver:MSSQLSERVER",
            None,
            None,
            None,
            50,
        )
        .unwrap_err();

        assert!(error.contains("instance_id"));
    }

    #[test]
    fn builds_sqlserver_command_with_instance_target() {
        let command = build_engine_command(
            DatabaseEngine::Sqlserver,
            DatabaseAction::PreviewTable,
            "sqlserver:SQLEXPRESS",
            Some("appdb"),
            Some("users"),
            None,
            50,
        )
        .unwrap();

        assert!(command.contains("-S \"localhost\\SQLEXPRESS\""));
    }

    #[test]
    fn uses_supplied_postgresql_schema_for_preview() {
        let command = build_engine_command_with_schema(
            DatabaseEngine::Postgresql,
            DatabaseAction::PreviewTable,
            "postgresql:main",
            Some("appdb"),
            Some("reporting"),
            Some("users"),
            None,
            25,
        )
        .unwrap();

        assert!(command.contains("FROM reporting.users"));
    }

    #[test]
    fn builds_sqlserver_process_plan_with_separate_sql_argument() {
        let plan = build_engine_command_plan_with_schema(
            DatabaseEngine::Sqlserver,
            DatabaseAction::PreviewTable,
            "sqlserver:SQLEXPRESS",
            Some("appdb"),
            Some("reporting"),
            Some("users"),
            None,
            25,
        )
        .unwrap();

        assert_eq!(plan.program, "sqlcmd");
        assert!(plan.args.contains(&"-Q".to_string()));
        assert!(plan
            .args
            .iter()
            .any(|arg: &String| arg.contains("SELECT TOP 25 * FROM [appdb].[reporting].[users];")));
        assert!(plan.args.iter().any(|arg| arg == "localhost\\SQLEXPRESS"));
    }

    #[test]
    fn builds_mysql_process_plan_with_instance_target_host() {
        let plan = build_engine_command_plan_with_schema(
            DatabaseEngine::Mysql,
            DatabaseAction::PreviewTable,
            "mysql:127.0.0.1:3306",
            Some("appdb"),
            None,
            Some("users"),
            None,
            10,
        )
        .unwrap();

        expect_args_include(&plan.args, "--host");
        expect_args_include(&plan.args, "127.0.0.1");
        expect_args_include(&plan.args, "--port");
        expect_args_include(&plan.args, "3306");
    }

    #[test]
    fn configures_mysql_client_for_utf8mb4_output() {
        let plan = build_engine_command_plan_with_schema(
            DatabaseEngine::Mysql,
            DatabaseAction::PreviewTable,
            "mysql:127.0.0.1:3306",
            Some("appdb"),
            None,
            Some("users"),
            None,
            10,
        )
        .unwrap();

        expect_args_include(&plan.args, "--default-character-set=utf8mb4");
    }

    #[test]
    fn configures_sqlcmd_for_utf8_output() {
        let plan = build_engine_command_plan_with_schema(
            DatabaseEngine::Sqlserver,
            DatabaseAction::PreviewTable,
            "sqlserver:MSSQLSERVER",
            Some("appdb"),
            Some("dbo"),
            Some("users"),
            None,
            10,
        )
        .unwrap();

        expect_args_include(&plan.args, "-f");
        expect_args_include(&plan.args, "65001");
    }

    #[test]
    fn prefixes_sqlserver_queries_with_no_count() {
        let plan = build_engine_command_plan_with_schema(
            DatabaseEngine::Sqlserver,
            DatabaseAction::ListDatabases,
            "sqlserver:MSSQLSERVER",
            None,
            None,
            None,
            None,
            10,
        )
        .unwrap();

        let query_index = plan.args.iter().position(|arg| arg == "-Q").unwrap() + 1;
        assert!(plan.args[query_index].starts_with("SET NOCOUNT ON; "));
    }

    #[test]
    fn configures_postgresql_client_for_utf8_output() {
        let plan = build_engine_command_plan_with_schema(
            DatabaseEngine::Postgresql,
            DatabaseAction::PreviewTable,
            "postgresql:127.0.0.1:5432",
            Some("appdb"),
            Some("public"),
            Some("users"),
            None,
            10,
        )
        .unwrap();

        assert!(plan
            .env
            .iter()
            .any(|(key, value)| key == "PGCLIENTENCODING" && value == "UTF8"));
    }

    #[test]
    fn deserializes_request_from_camel_case_fields() {
        let request: WindowsDatabaseRequest = serde_json::from_value(json!({
            "engine": "mysql",
            "action": "previewTable",
            "instanceId": "mysql:127.0.0.1:3306",
            "database": "appdb",
            "table": "users",
            "rowLimit": 25
        }))
        .unwrap();

        assert_eq!(request.instance_id, "mysql:127.0.0.1:3306");
        assert_eq!(request.row_limit, Some(25));
    }

    #[test]
    fn deserializes_mutation_request_from_camel_case_fields() {
        let request: WindowsDatabaseMutationRequest = serde_json::from_value(json!({
            "engine": "mysql",
            "action": "updateRow",
            "instanceId": "mysql:127.0.0.1:3306",
            "database": "appdb",
            "table": "users",
            "values": { "email": "new@example.com" },
            "rowIdentity": { "columns": [{ "name": "id", "value": "7" }] },
            "generatedColumns": ["id"]
        }))
        .unwrap();

        assert_eq!(request.instance_id, "mysql:127.0.0.1:3306");
        assert_eq!(request.generated_columns, Some(vec!["id".to_string()]));
    }

    #[test]
    fn rejects_update_without_row_identity() {
        let request = mutation_request(DatabaseEngine::Mysql, DatabaseMutationAction::UpdateRow);
        let error = build_mutation_command_plan(&WindowsDatabaseMutationRequest {
            row_identity: None,
            ..request
        })
        .unwrap_err();

        assert!(error.contains("row identity"));
    }

    #[test]
    fn builds_mysql_insert_with_escaped_literals() {
        let request = WindowsDatabaseMutationRequest {
            engine: DatabaseEngine::Mysql,
            action: DatabaseMutationAction::InsertRow,
            instance_id: "mysql:127.0.0.1:3306".to_string(),
            database: "appdb".to_string(),
            schema: None,
            table: "users".to_string(),
            values: Some(json!({ "email": "o'reilly@example.com", "nickname": null })),
            row_identity: None,
            generated_columns: Some(vec!["id".to_string()]),
        };

        let plan = build_mutation_command_plan(&request).unwrap();
        let sql = plan.args.last().unwrap();

        assert!(sql.contains("INSERT INTO `users`"));
        assert!(sql.contains("'o''reilly@example.com'"));
        assert!(sql.contains("NULL"));
        assert!(!sql.contains("`id`"));
    }

    #[test]
    fn builds_sqlserver_update_with_single_row_guard() {
        let request = WindowsDatabaseMutationRequest {
            engine: DatabaseEngine::Sqlserver,
            action: DatabaseMutationAction::UpdateRow,
            instance_id: "sqlserver:MSSQLSERVER".to_string(),
            database: "appdb".to_string(),
            schema: Some("dbo".to_string()),
            table: "users".to_string(),
            values: Some(json!({ "email": "new@example.com" })),
            row_identity: Some(RowIdentity {
                columns: vec![RowIdentityColumn {
                    name: "id".to_string(),
                    value: json!("7"),
                }],
            }),
            generated_columns: None,
        };

        let plan = build_mutation_command_plan(&request).unwrap();
        let sql = plan.args.last().unwrap();

        assert!(sql.contains("UPDATE TOP (1) [dbo].[users]"));
        assert!(sql.contains("WHERE [id] = '7'"));
    }

    #[test]
    fn builds_postgresql_delete_with_returning_guard() {
        let request = WindowsDatabaseMutationRequest {
            engine: DatabaseEngine::Postgresql,
            action: DatabaseMutationAction::DeleteRow,
            instance_id: "postgresql:127.0.0.1:5432".to_string(),
            database: "appdb".to_string(),
            schema: Some("public".to_string()),
            table: "users".to_string(),
            values: None,
            row_identity: Some(RowIdentity {
                columns: vec![RowIdentityColumn {
                    name: "id".to_string(),
                    value: json!(7),
                }],
            }),
            generated_columns: None,
        };

        let plan = build_mutation_command_plan(&request).unwrap();
        let sql = plan.args.last().unwrap();

        assert!(sql.contains("WITH target AS"));
        assert!(sql.contains("DELETE FROM public.users"));
        assert!(sql.contains("RETURNING 1"));
    }

    #[test]
    fn rejects_unsafe_identifier_in_mutation_request() {
        let error = build_mutation_command_plan(&WindowsDatabaseMutationRequest {
            table: "users; DROP TABLE users".to_string(),
            ..mutation_request(DatabaseEngine::Mysql, DatabaseMutationAction::InsertRow)
        })
        .unwrap_err();

        assert!(error.contains("identifier"));
    }

    fn mutation_request(
        engine: DatabaseEngine,
        action: DatabaseMutationAction,
    ) -> WindowsDatabaseMutationRequest {
        WindowsDatabaseMutationRequest {
            engine,
            action,
            instance_id: match engine {
                DatabaseEngine::Mysql => "mysql:127.0.0.1:3306",
                DatabaseEngine::Sqlserver => "sqlserver:MSSQLSERVER",
                DatabaseEngine::Postgresql => "postgresql:127.0.0.1:5432",
            }
            .to_string(),
            database: "appdb".to_string(),
            schema: None,
            table: "users".to_string(),
            values: Some(json!({ "email": "new@example.com" })),
            row_identity: Some(RowIdentity {
                columns: vec![RowIdentityColumn {
                    name: "id".to_string(),
                    value: json!("7"),
                }],
            }),
            generated_columns: None,
        }
    }

    fn expect_args_include(args: &[String], expected: &str) {
        assert!(args.iter().any(|arg| arg == expected));
    }
}
