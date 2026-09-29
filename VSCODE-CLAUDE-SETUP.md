# VS Code + 心流 Claude Opus 5.5

本项目已经配置为通过心流调用 `claude-opus-5-5`。

## 启动方式

1. 在 VS Code 中打开本项目文件夹。
2. 打开“终端”→“运行任务”。
3. 选择“Claude Code：心流 Opus 5.5”。

也可以在 VS Code 终端中直接运行：

```powershell
claude --model claude-opus-5-5
```

## 当前配置

- API 地址：`https://iliu.ai`
- 模型：`claude-opus-5-5`
- API Key：使用本机全局 Claude 设置中的现有心流密钥，不保存在本项目中

## 验证

启动后发送一条短消息，再到心流后台的“使用日志”确认：

- 模型为 `claude-opus-5-5`
- 接口为 `/v1/messages`

如果出现 `No available channel` 或模型不存在，需要在心流后台把当前 Key 切换到支持 `claude-opus-5-5` 的分组。
