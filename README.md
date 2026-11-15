# 协作台账录入的三方字段冲突核对

这是 threeway-rpa 的 Node.js 项目。现有能力是本地资料源启动、来源检查和接口演练；资料接收工作流由 `src/workflow.mjs` 承载，提供基于浏览器的增量录入与字段级三方核对。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。浏览器使用 Playwright 1.56.1 与 Chromium，镜像中包含匹配的浏览器。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t threeway-rpa:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
npm start -- --host 127.0.0.1 --port 3000
```

`npm test` 检查已有资料源与真实浏览器页面。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

`npm start` 启动带业务接口的门户服务，首页与 `/portal` 均可操作。可用 `HOST`、`PORT` 配置监听地址，也可通过 `--host`、`--port` 覆盖；默认使用回环地址和自动分配端口。页面与 `/portal/state`、`/portal/action` 必须由同一进程提供，不能只用静态文件服务器托管 web 目录。

## 工作流接入

业务入口约定为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入，stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json，其他持久状态布局由业务模块决定。不能依赖调用方持有的内存来完成恢复。

input.base 是导入时基值，input.desired 只包含本次想改变字段；网页提供最新对象与版本。保存 automatic 方法会清空 container。输出 state=saved/conflict/unchanged 和 record；同字段各改不同值不可保存。网页动作来自实际控件，不接受直接内部写请求。

### 核对与恢复行为

- 字段级三方核对：回读已等于想写值判为无需改动（含双方改成相同结果）；只有我方改的字段才写入；想写值等于基值视为我方未改、保留现场；同字段各改不同值留下真正冲突，整行不写，不覆盖任何一方。
- 写操作只通过页面可见控件（刷新、填写、保存按钮）完成；每次保存前以最新回读为准，保存后回读整个业务对象核对，门户规范化造成的关联字段变化（如 container 被清空）单独标记为规范化差异。
- 保存时版本已变化则重新回读、重新核对后有限重试（至多 3 次），已等于想写值的字段退出待写集合，不反复追加；超过上限或存在冲突时以 conflict 结束并说明原因。
- 每次执行都以门户实际台账为准重新计算，不读取本地“已点击保存”的记录决定跳过；stateDir/audit.jsonl 只追加记录回读、保存响应等证据供事后复核，因此中断后重跑自然收敛，不会重复写入。

结果中 `fields` 给出每字段的 base/desired/before/after 与状态，`review` 按 已写入 / 无需改动 / 保留未动 / 规范化差异 / 真正冲突 / 未写入 归组，便于逐行复核。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run demo
```

acceptance 检查结果、落盘内容和实际来源访问，并覆盖合并规则、幂等重跑、冲突保护与版本变化重试；demo 从干净临时状态启动本地服务，实际执行前三种情况并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none threeway-rpa:local npm test`。工作流开发完成后执行 `docker run --rm --network none threeway-rpa:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
