# Opinion HUD Test Cases

这个文件夹用于存放测试用的推文数据。

## 使用方法

### 1. 收集测试推文

在 `positive.txt` 中添加应该匹配到市场的推文（每行一条）：

```
随着 @Lighter_xyz 基本确认今年内tge ，FDV 1B这个市场存在被低估可能性
Trump在PA州的民调领先5个点
BTC要冲10万了，corn season来了
```

**格式规则**：
- 每行一条推文
- 空行会被忽略
- 以 `#` 开头的行会被忽略（可以用作注释）

### 2. 运行批量测试

1. 打开Chrome扩展的选项页面（右键扩展图标 → 选项）
2. 滚动到底部的 **"Batch Test"** 部分
3. 复制 `positive.txt` 的内容粘贴到输入框
4. 调整阈值（默认0.35）
5. 点击 **"Run Batch Test"** 按钮

### 3. 查看结果

测试报告会显示：
- 每条推文是否匹配成功 ✓ / ✗
- 匹配到的市场标题
- 匹配分数和原因
- 总体成功率

**示例输出**：
```
=== BATCH TEST RESULTS ===
Total tweets: 3
Threshold: 0.35

[1/3] 随着 @Lighter_xyz 基本确认今年内tge ，FDV 1B这个市场存在...
  ✓ MATCHED (score: 0.42)
    Lighter market cap (FDV) one day after launch?
    Keyword: lighter market | Reason: partial:lighter

[2/3] Trump在PA州的民调领先5个点
  ✓ MATCHED (score: 0.65)
    Will Trump win Pennsylvania in 2024?
    Keyword: trump | Reason: single:trump

[3/3] 今天天气真好
  ✗ NO MATCH

=== SUMMARY ===
Matched: 2/3 (66.7%)
Not matched: 1/3 (33.3%)
```

## 注意事项

- 测试完全在本地进行，不会上传任何数据到服务器
- 测试使用的是当前缓存的 `data.json`，确保先点击 "Refresh Now" 获取最新数据
- 可以调整阈值来观察不同严格程度下的匹配效果
