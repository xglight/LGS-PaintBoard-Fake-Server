# LGS-PaintBoard-Fake-Server

用于 [LGS Paintboard 2026 冬日绘板](https://www.luogu.com.cn/article/pssi9ceo) 的模拟服务器，可以用来测试脚本。

采用 Node.js 编写，HTTP 依赖 Fastify 框架，WebSocket 依赖 ws 库。

Token 储存采用 SQLite 数据库，数据库文件为 `tokens.db`。

## 项目架构

```bash
XG-LGS-PaintBoard/
├─ README.md                       # 项目说明
├─ API.md                          # 接口协议
├─ config.json                     # 配置文件
├─ config.example.json                     # 示例配置文件
├─ server.mjs                      # 服务器主程序
├─ config.mjs                      # 读取配置文件
├─ logger.mjs                      # 日志模块
└─ frontend/
   └─ index.html                   # 前端页面
```
## 前端

AI 写的，挺适合测试的。

## 配置文件字段

可参考 `config.example.json`。

### API

|    字段    |  类型  |   默认值    |   说明   |
| :--------: | :----: | :---------: | :------: |
| `protocol` | string |   `http`    |   协议   |
|   `host`   | string | `localhost` |   主机   |
|   `port`   | number |    3000     | API 端口 |

### WebSocket

|        字段         |  类型  |   默认值    |             说明             |
| :-----------------: | :----: | :---------: | :--------------------------: |
|     `protocol`      | string |    `ws`     |             协议             |
|       `host`        | string | `localhost` |             主机             |
|       `port`        | number |    3001     |        WebSocket 端口        |
| `maxReadWritePerIP` | number |      3      | 每个 IP 最大读写连接建立个数 |
| `maxReadOnlyPerIP`  | number |     50      | 每个 IP 最大只读连接建立个数 |
| `maxWriteOnlyPerIP` | number |      5      | 每个 IP 最大只写连接建立个数 |
| `packetsPerSecond`  | number |     256     |   每个连接最大每秒发送包数   |
|   `pingInterval`    | number |    30000    |     WebSocket 心跳包间隔     |
|    `pingTimeout`    | number |    10000    |     WebSocket 心跳包超时     |

### log
|    字段    |  类型  | 默认值 |                      说明                       |
| :--------: | :----: | :----: | :---------------------------------------------: |
| `logLevel` | string | `info` | 日志级别，可选 `debug`, `info`, `warn`, `error` |

### board

|    字段    |  类型  | 默认值 |       说明        |
| :--------: | :----: | :----: | :---------------: |
|  `height`  | number |  600   | 绘板高度（像素）  |
|  `width`   | number |  1000  | 绘板宽度（像素）  |
| `channels` | number |   3    | 绘板通道数（RGB） |

### token

|     字段     |  类型   | 默认值 |         说明         |
| :----------: | :-----: | :----: | :------------------: |
| `cooldownMs` | number  |   1    | 令牌冷却时间（毫秒） |
|   `check`    | boolean | false  | 是否检查令牌是否有效 |
