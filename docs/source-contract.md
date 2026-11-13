# 来源与接收约定

input.base 是导入时基值，input.desired 只包含本次想改变字段；网页提供最新对象与版本。保存 automatic 方法会清空 container。输出 state=saved/conflict/unchanged 和 record；同字段各改为不同值不可保存。网页动作来自实际控件，不接受直接内部写请求。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 不同字段保留双方修改

业务输入：
```json
{
  "base": {
    "note": "原备注",
    "method": "manual",
    "container": "glass"
  },
  "desired": {
    "method": "automatic"
  }
}
```
结果必须包含：
```json
{
  "state": "saved",
  "record": {
    "note": "现场新备注",
    "method": "automatic",
    "container": ""
  }
}
```

### 同字段不同修改留冲突

业务输入：
```json
{
  "base": {
    "note": "原备注"
  },
  "desired": {
    "note": "导入备注"
  }
}
```
结果必须包含：
```json
{
  "state": "conflict",
  "record": {
    "note": "现场新备注"
  }
}
```

### 相同修改无需再写

业务输入：
```json
{
  "base": {
    "note": "原备注"
  },
  "desired": {
    "note": "现场新备注"
  }
}
```
结果必须包含：
```json
{
  "state": "unchanged"
}
```
