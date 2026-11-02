# `@dsh-plugins/build-config`

仓库内的两份 tsdown 预设，只被各插件包的 `tsdown.config.ts` 引用。**不要从运行时
代码 import 它**：它不会随插件发布，git 安装时也不一定被安装。

| 导出 | 产物 | 用途 |
|---|---|---|
| `hostConfig()` | `lib/index.js`（ESM） | 宿主半，Node 面 Cordis 插件 |
| `clientConfig()` | `lib/client.js` | 浏览器半，`window.__ModuleLoader__.load({id, factory})` 产物 |

两者都从工作目录的 `package.json` 读插件 id 与包名，所以插件 id 只在一个地方声明。
预设导出的都是普通 tsdown 配置对象，可以直接覆盖字段：

```ts
import { defineConfig } from 'tsdown'
import { clientConfig } from '@dsh-plugins/build-config'

export default defineConfig([
  clientConfig({ external: ['some-unvendored-package'] }),
])
```

## 为什么浏览器半要包一层

Web GUI 的插件 bundle 不是普通 ESM/CJS 模块，而是一个注册函数：

```js
window.__ModuleLoader__.load({ id: '<package-name>', factory: (require) => { … } })
```

`factory` 里是普通 CJS 代码，`require` 由页面的冻结模块表提供，因此 `react`、
`react-dom` 和 `@deepseek-ai/*` 必须保持 external，运行时才能共享同一份实例。
平台模块表之外的请求写进 `package.json` 的 `dsh.client.external`。
