use crate::{run_local_process, ssh::CommandResult};
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct DatabaseCommandPlan {
    program: String,
    args: Vec<String>,
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
        engine, action, instance_id, database, schema, table, sql, row_limit,
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
        },
        DatabaseEngine::Sqlserver => DatabaseCommandPlan {
            program: "sqlcmd".to_string(),
            args: build_sqlserver_args(
                &sqlserver_server_arg(instance_target),
                database,
                &query,
            ),
        },
        DatabaseEngine::Postgresql => DatabaseCommandPlan {
            program: "psql".to_string(),
            args: build_postgresql_args(instance_target, database, &query),
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

    run_local_process(&plan.program, &plan.args)
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
    ];
    if !database.is_empty() {
        args.push("-d".to_string());
        args.push(database.to_string());
    }
    args.push("-Q".to_string());
    args.push(query.to_string());
    args
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
        build_engine_command_with_schema, ensure_readonly_sql, DatabaseAction, DatabaseEngine,
        WindowsDatabaseRequest,
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

    fn expect_args_include(args: &[String], expected: &str) {
        assert!(args.iter().any(|arg| arg == expected));
    }
}
