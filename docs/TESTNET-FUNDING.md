# 测试资产准备

用 `pnpm testnet:prepare` 生成专用测试账户，再用 `pnpm testnet:funding` 检查其公开地址和余额。账户记录保存在忽略的 `.runtime/testnet-accounts/`，不要提交私钥或将个人主钱包用于测试。

部署者与实际发送交易的账户需要 test MON；充值资金 Owner 需要 Monad Testnet USDC。角色与部署步骤见 [部署说明](DEPLOYMENT.md)。金额根据预检和剩余 gas 自行核对。

- [Monad 测试水龙头](https://faucet.monad.xyz/)
- [Circle 测试 USDC](https://faucet.circle.com/)

本文件不包含任何维护者的收款地址。不要向代码中的公开本地开发账户充值真实资产。
