# PRPLL Docker for CUDA

使用 Docker 一键部署 [PRPLL](https://github.com/tdulcet/PRPLL)（GPU 梅森素数 PRP/证明测试）和 [AutoPrimeNet](https://github.com/tdulcet/AutoPrimeNet)（PrimeNet 任务自动领取与结果上报）.

仅支持 CUDA！

## 目录结构

```
.
├── .github/workflows/     # CI/CD：构建并推送镜像到 GHCR
├── AutoPrimeNet/          # AutoPrimeNet 镜像构建
├── PRPLL/                 # PRPLL 镜像构建
├── data/                  # 数据目录（首次启动后自动生成）
├── docker-compose.yml     # 服务编排
└── start.sh               # 一键启动脚本
```

## 环境要求

- NVIDIA GPU
- Docker 及 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- Linux 主机（Windows 请使用 WSL2 配合 Docker Desktop，实测能跑）

## 快速开始

直接运行启动脚本：

```bash
./start.sh
```

首次运行时会自动构建镜像并进入 AutoPrimeNet 交互式配置，请按提示填写 PrimeNet 用户名等信息

配置完成后会生成 `data/prime.ini`. 再次运行脚本即以后台方式启动服务

也可以手动操作：

```bash
# 首次配置
docker compose run --rm autoprimenet --setup --prpll -w /opt/autoprimenet/data/ -l prime.ini

# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f
```

## 服务说明

| 服务 | 作用 | 网络 |
| --- | --- | --- |
| `prpll` | GPU 端执行 PRP 测试，数据目录为 `./data` | 无需网络 |
| `autoprimenet` | 从 PrimeNet 领取任务、监测 PRPLL 进度并上报结果 | 正常网络 |

两个服务共享同一个 `data/` 目录：AutoPrimeNet 负责写入 `worktodo.txt` 并从 `results.txt` 读取结果，PRPLL 负责实际计算

## 数据目录

`data/` 首次启动时自动创建，主要文件：

- `prime.ini` — AutoPrimeNet 配置（用户名、工作偏好、每轮检查间隔等）
- `config.txt` — PRPLL 命令行参数（如 `-use INPLACE=1`、`-use CARRY64=1`）
- `worktodo.txt` / `results.txt` — 待测任务 / 计算结果
- `<exponent>/` — 各指数的证明文件与临时文件
- `autoprimenet.log` / `gpuowl-*.log` — 日志，监工用

## 相关链接

- [PRPLL](https://github.com/tdulcet/PRPLL) — GPU 梅森素数测试程序
- [AutoPrimeNet](https://github.com/tdulcet/AutoPrimeNet) — PrimeNet 自动化工具
- [PrimeNet](https://www.mersenne.org/) — GIMPS 任务分配服务器

项目 by [人](https://space.bilibili.com/431304449)
README by [DeepSeek](https://chat.deepseek.com) + [人](https://space.bilibili.com/431304449)