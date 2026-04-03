# E2E 双端对战测试

## 1. 安装依赖

```bash
npm install
npx playwright install chromium
```

## 2. 启动服务

```bash
docker compose up -d --build
```

默认 Compose 配置不会开启 E2E 测试钩子。
`npm run test:e2e`、`npm run test:e2e:headed` 和 `npm run test:e2e:ui` 会在测试开始前显式注入 `E2E_ENABLE_TEST_HOOKS=1` 重建 `app` 服务，并在测试退出后自动恢复为默认关闭状态。

默认测试地址是 `http://localhost`。
如端口不是 80，可设置：

```bash
E2E_BASE_URL=http://localhost:8080 npm run test:e2e
```

## 3. 运行测试

```bash
npm run test:e2e
```

只跑 Phase2 与 Round end 聚焦集：

```bash
npm run test:e2e:phase2
```

可视化模式：

```bash
npm run test:e2e:headed
```

如果需要手工开启测试钩子做排查，可单独执行：

```bash
E2E_ENABLE_TEST_HOOKS=1 docker compose up -d --build --force-recreate app
```

恢复默认关闭状态：

```bash
docker compose up -d --build --force-recreate app
```

## 4. 默认账号

- player1 / pass1
- player2 / pass2

可通过环境变量覆盖：

- `E2E_USER1`, `E2E_PASS1`
- `E2E_USER2`, `E2E_PASS2`
