"""
许可证生成器 GUI 工具
用于根据用户机器码生成许可证密钥
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import json
import base64
import os
from datetime import datetime, timedelta

# 尝试导入 ed25519 库
try:
    from nacl.signing import SigningKey
    NACL_AVAILABLE = True
except ImportError:
    NACL_AVAILABLE = False
    print("警告: nacl 库未安装，请运行: pip install pynacl")

# 默认私钥路径
DEFAULT_PRIVATE_KEY = "613f2ed412736c7e6eabff5d8881f1c22e1c86b5a60bc0f319c02652be52d661"

# XOR 混淆密钥 (必须与 Rust 端完全一致)
OBFUSCATE_KEY = b"Lumina_Emergency_Analyzer_2024_SecretKey!@#$%^&*"


def xor_obfuscate(data: bytes) -> bytes:
    """XOR 加密/解密 (对称操作)"""
    return bytes([byte ^ OBFUSCATE_KEY[i % len(OBFUSCATE_KEY)] for i, byte in enumerate(data)])


class LicenseGenerator:
    def __init__(self, root):
        self.root = root
        self.root.title("许可证生成器 v1.0")
        self.root.geometry("600x550")
        self.root.resizable(False, False)
        
        # 设置样式
        style = ttk.Style()
        style.configure('Title.TLabel', font=('Microsoft YaHei', 14, 'bold'))
        style.configure('Info.TLabel', font=('Microsoft YaHei', 9))
        
        self.create_widgets()
        self.load_private_key()
        
    def create_widgets(self):
        # 主框架
        main_frame = ttk.Frame(self.root, padding="20")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # 标题
        title_label = ttk.Label(main_frame, text="🔐 许可证生成器", style='Title.TLabel')
        title_label.pack(pady=(0, 20))
        
        # 私钥区域
        key_frame = ttk.LabelFrame(main_frame, text="私钥配置", padding="10")
        key_frame.pack(fill=tk.X, pady=(0, 15))
        
        ttk.Label(key_frame, text="私钥 (Hex):").pack(anchor=tk.W)
        self.private_key_var = tk.StringVar(value=DEFAULT_PRIVATE_KEY)
        self.private_key_entry = ttk.Entry(key_frame, textvariable=self.private_key_var, width=70, show="*")
        self.private_key_entry.pack(fill=tk.X, pady=(5, 0))
        
        # 机器码区域
        machine_frame = ttk.LabelFrame(main_frame, text="机器码", padding="10")
        machine_frame.pack(fill=tk.X, pady=(0, 15))
        
        ttk.Label(machine_frame, text="用户机器码:").pack(anchor=tk.W)
        self.machine_id_var = tk.StringVar()
        self.machine_id_entry = ttk.Entry(machine_frame, textvariable=self.machine_id_var, width=70)
        self.machine_id_entry.pack(fill=tk.X, pady=(5, 0))
        
        # 授权信息区域
        info_frame = ttk.LabelFrame(main_frame, text="授权信息", padding="10")
        info_frame.pack(fill=tk.X, pady=(0, 15))
        
        # 用户名
        row1 = ttk.Frame(info_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="用户名:", width=12).pack(side=tk.LEFT)
        self.user_name_var = tk.StringVar()
        ttk.Entry(row1, textvariable=self.user_name_var, width=40).pack(side=tk.LEFT, padx=(5, 0))
        
        # 过期时间
        row2 = ttk.Frame(info_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Label(row2, text="过期时间:", width=12).pack(side=tk.LEFT)
        self.expire_var = tk.StringVar()
        ttk.Entry(row2, textvariable=self.expire_var, width=20).pack(side=tk.LEFT, padx=(5, 0))
        ttk.Label(row2, text="(格式: YYYY-MM-DD, 留空为永久)", style='Info.TLabel').pack(side=tk.LEFT, padx=(10, 0))
        
        # 快捷按钮
        row3 = ttk.Frame(info_frame)
        row3.pack(fill=tk.X, pady=5)
        ttk.Label(row3, text="快捷设置:", width=12).pack(side=tk.LEFT)
        ttk.Button(row3, text="1个月", command=lambda: self.set_expire_days(30), width=8).pack(side=tk.LEFT, padx=2)
        ttk.Button(row3, text="3个月", command=lambda: self.set_expire_days(90), width=8).pack(side=tk.LEFT, padx=2)
        ttk.Button(row3, text="1年", command=lambda: self.set_expire_days(365), width=8).pack(side=tk.LEFT, padx=2)
        ttk.Button(row3, text="永久", command=lambda: self.expire_var.set(""), width=8).pack(side=tk.LEFT, padx=2)
        
        # 生成按钮
        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(pady=15)
        
        generate_btn = ttk.Button(btn_frame, text="🔑 生成许可证", command=self.generate_license, width=20)
        generate_btn.pack(side=tk.LEFT, padx=5)
        
        copy_btn = ttk.Button(btn_frame, text="📋 复制", command=self.copy_license, width=10)
        copy_btn.pack(side=tk.LEFT, padx=5)
        
        clear_btn = ttk.Button(btn_frame, text="🗑️ 清空", command=self.clear_all, width=10)
        clear_btn.pack(side=tk.LEFT, padx=5)
        
        # 结果区域
        result_frame = ttk.LabelFrame(main_frame, text="生成的许可证", padding="10")
        result_frame.pack(fill=tk.BOTH, expand=True)
        
        self.result_text = tk.Text(result_frame, height=6, wrap=tk.WORD, font=('Consolas', 9))
        self.result_text.pack(fill=tk.BOTH, expand=True)
        
        # 状态栏
        self.status_var = tk.StringVar(value="就绪")
        status_bar = ttk.Label(self.root, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        status_bar.pack(side=tk.BOTTOM, fill=tk.X)
        
    def load_private_key(self):
        """尝试从文件加载私钥"""
        key_file = os.path.join(os.path.dirname(__file__), "private.key")
        if os.path.exists(key_file):
            with open(key_file, 'r') as f:
                key = f.read().strip()
                if len(key) == 64:
                    self.private_key_var.set(key)
                    self.status_var.set("已加载私钥文件")
                    
    def set_expire_days(self, days):
        """设置过期天数"""
        expire_date = datetime.now() + timedelta(days=days)
        self.expire_var.set(expire_date.strftime("%Y-%m-%d"))
        
    def generate_license(self):
        """生成许可证"""
        if not NACL_AVAILABLE:
            messagebox.showerror("错误", "nacl 库未安装\n请运行: pip install pynacl")
            return
            
        machine_id = self.machine_id_var.get().strip()
        if not machine_id:
            messagebox.showwarning("警告", "请输入机器码")
            return
            
        private_key_hex = self.private_key_var.get().strip()
        if len(private_key_hex) != 64:
            messagebox.showerror("错误", f"私钥格式错误 (当前长度: {len(private_key_hex)}, 应为64位十六进制)")
            return
            
        try:
            # 解析私钥
            private_key_bytes = bytes.fromhex(private_key_hex)
            signing_key = SigningKey(private_key_bytes)
            
            # 构建许可证信息
            expire_date = self.expire_var.get().strip()
            user_name = self.user_name_var.get().strip()
            
            license_info = {
                "machine_id": machine_id,
                "expire_date": expire_date if expire_date else None,
                "features": ["all"],
                "user_name": user_name if user_name else None
            }
            
            # 序列化 - 确保顺序一致
            license_json = json.dumps(license_info, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
            
            # 加密数据 (XOR 混淆)
            encrypted_data = xor_obfuscate(license_json)
            
            # 签名 (对加密后的数据签名)
            signed = signing_key.sign(encrypted_data)
            signature = signed.signature  # 64 bytes
            
            # 组合: 签名 + 加密数据
            license_bytes = signature + encrypted_data
            
            # Base64 编码
            license_key = base64.b64encode(license_bytes).decode('utf-8')
            
            # 显示结果
            self.result_text.delete(1.0, tk.END)
            self.result_text.insert(tk.END, license_key)
            
            expire_display = expire_date if expire_date else "永久"
            user_display = user_name if user_name else "未设置"
            self.status_var.set(f"✅ 生成成功 - 用户: {user_display} - 过期: {expire_display}")
            
            messagebox.showinfo("成功", f"许可证已生成！\n\n用户: {user_display}\n过期: {expire_display}\n\n请复制下方的许可证密钥发给用户。")
            
        except ValueError as e:
            messagebox.showerror("错误", f"私钥解析失败: {str(e)}")
            self.status_var.set(f"❌ 私钥解析失败")
        except Exception as e:
            messagebox.showerror("错误", f"生成失败: {str(e)}")
            self.status_var.set(f"❌ 生成失败: {str(e)}")
            
    def copy_license(self):
        """复制许可证到剪贴板"""
        license_key = self.result_text.get(1.0, tk.END).strip()
        if license_key:
            self.root.clipboard_clear()
            self.root.clipboard_append(license_key)
            self.status_var.set("📋 已复制到剪贴板")
        else:
            messagebox.showwarning("警告", "没有可复制的许可证")
            
    def clear_all(self):
        """清空所有输入"""
        self.machine_id_var.set("")
        self.user_name_var.set("")
        self.expire_var.set("")
        self.result_text.delete(1.0, tk.END)
        self.status_var.set("已清空")


def main():
    root = tk.Tk()
    app = LicenseGenerator(root)
    root.mainloop()


if __name__ == "__main__":
    main()
