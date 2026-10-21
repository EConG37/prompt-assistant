#!/bin/zsh
# 双击本脚本即可启动「提示词助手」（开发运行用；打包版直接双击 .app）
# 使用脚本自身所在目录，拷贝到任何位置均可运行
cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/electron .
