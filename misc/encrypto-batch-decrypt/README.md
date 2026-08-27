# Encrypto 批量解密脚本

通过 Windows UI Automation 自动操作 Encrypto 1.0.1，批量解密 `.crypto` 文件。

脚本会读取 Encrypto 界面中的密码提示，将提示作为游戏王卡名查询百鸽（ygocdb）API，并使用搜索结果的卡片 `id` 作为解密密码。

## 功能

- 递归扫描目录中的 `.crypto` 文件。
- 每个文件自动读取 Encrypto 密码提示并查询卡片密码。
- 默认把解密结果保存到对应 `.crypto` 文件旁边。
- 保留所有 `.crypto` 源文件。
- 保留源目录的相对子目录结构。
- 默认跳过已有输出，避免覆盖。
- 使用 `--overwrite` 时自动确认覆盖。
- 单个文件失败后记录日志并继续处理后续文件。
- 每个文件使用独立的 Encrypto 进程，避免前一个文件的界面状态影响后续文件。
- 只有 Encrypto 显示 `File Decrypted and Saved!` 完成界面且输出文件存在时，才记录为成功。
- 全部处理结束后自动关闭 Encrypto。

## 环境要求

- Windows
- Encrypto 1.0.1，默认安装位置：

  ```text
  C:\Program Files\Encrypto\Encrypto.exe
  ```

- [uv](https://docs.astral.sh/uv/)
- 能够访问 `https://ygocdb.com/api/v0/`

## 使用方法

### 无后缀文件先改名

Encrypto 依靠 `.crypto` 后缀识别解密模式。待解密文件没有后缀时，必须先给文件名添加 `.crypto`，再交给脚本处理；不要把无后缀文件直接作为输入。

例如：

```powershell
Rename-Item -LiteralPath "C:\待解密\example" -NewName "example.crypto"
uv run .\encrypto_batch_decrypt.py "C:\待解密\example.crypto"
```

批量改名之前应先确认目录中不存在同名 `.crypto` 文件，避免名称冲突。

### 批量处理目录

下面的命令递归处理 `C:\待解密`，每个结果保存到对应源文件旁边：

```powershell
uv run .\encrypto_batch_decrypt.py "C:\待解密"
```

例如处理脚本上一级的测试目录：

```powershell
uv run .\encrypto_batch_decrypt.py ..
```

### 处理单个文件

```powershell
uv run .\encrypto_batch_decrypt.py "C:\待解密\example.crypto"
```

### 保存到指定目录

第二个位置参数可以指定输出根目录：

```powershell
uv run .\encrypto_batch_decrypt.py "C:\待解密" "D:\已解密"
```

### 覆盖已有输出

```powershell
uv run .\encrypto_batch_decrypt.py "C:\待解密" --overwrite
```

### 完成后保留 Encrypto 窗口

默认会自动关闭 Encrypto。如需保留完成界面：

```powershell
uv run .\encrypto_batch_decrypt.py "C:\待解密" --keep-open
```

### 调整超时

解密及保存完成的单步超时默认是 1800 秒（30 分钟）。它只是最长等待上限；界面状态一旦变化，脚本会立即继续，不会固定等待 30 分钟。

如果需要处理更大的文件或较慢的磁盘，可以进一步提高：

```powershell
uv run .\encrypto_batch_decrypt.py "C:\待解密" --timeout 3600
```

点击 `Save As...` 后等待 Windows 保存对话框出现的上限是 60 秒。这个阶段实测通常只需数秒，并以 0.05 秒间隔检测。

### 检查 UI Automation 控件

排查不同 Encrypto 界面版本时使用：

```powershell
uv run .\encrypto_batch_decrypt.py "C:\待解密\example.crypto" --inspect
```

## 已有文件处理规则

最终文件名以 Encrypto“另存为”对话框中自动给出的默认文件名为准。脚本会原样保留这个文件名，只修改保存目录，不会根据外层 `.crypto` 文件名自行拼接或猜测输出名称。

例如，输入文件可能叫：

```text
124638B.crypto
```

而 Encrypto 给出的默认文件名可能是：

```text
124638.7z.002
```

脚本最终保存的就是 `124638.7z.002`。如果无法读取保存框中的默认文件名，本次处理会直接报错，避免生成错误名称。

已有文件检查会在读取默认文件名之后进行。当该默认名称对应的输出已经存在时：

- 默认取消保存并记录 `SKIP`。
- 指定 `--overwrite` 后自动点击覆盖确认中的“是”。

## 密码来源

默认通过百鸽（ygocdb）API 自动获取每个文件的密码，无需额外指定参数。

流程如下：

1. 读取 Encrypto 中形如 `Hint: 深渊蔑噬` 的提示。
2. 请求 `https://ygocdb.com/api/v0/?search=深渊蔑噬`。
3. 在名称字段中进行精确匹配。
4. 使用唯一匹配结果的八位数字 `id` 作为密码。

接口连接失败时会有限重试。搜索不到唯一精确匹配时，该文件会失败并写入日志。

如果需要手动输入密码，使用 `--password-source prompt`：

```powershell
uv run .\encrypto_batch_decrypt.py "C:\待解密" --password-source prompt
```

脚本会在终端中询问一次密码，并将其复用于本次批量中的所有文件。

## 日志

日志文件名为：

```text
encrypto-batch.log
```

- 输入为单个文件时，日志写在该文件所在目录。
- 输入为目录时，日志写在输入目录根部。

常见状态：

```text
OK      解密并保存成功
SKIP    输出已经存在
FAILED  当前文件失败，脚本继续处理后续文件
Closed Encrypto  Encrypto 已在批次结束后关闭
```

## 注意事项

- 运行期间不要手动操作 Encrypto 的密码框、按钮或保存窗口。
- 目录扫描只处理 `.crypto` 文件，其他扩展名会被忽略。
- 脚本依赖 Encrypto 1.0.1 当前暴露的 UI Automation 控件 ID。
- `--overwrite` 会替换已有的解密输出；`.crypto` 源文件始终保留。
- 如果 Encrypto 安装在其他位置，使用 `--encrypto` 指定：

  ```powershell
  uv run .\encrypto_batch_decrypt.py "C:\待解密" --encrypto "D:\Apps\Encrypto\Encrypto.exe"
  ```
