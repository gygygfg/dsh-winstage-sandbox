# R11-D-13d 载体档位审计（**运行级**）

生成：2026-10-09T17:29:33.036Z

规则：`tierEffective==T1` ⇒ **VOID**（无 shim/无 overlay）；`TS` 或"暂存树里带 shim 产物（config/shim.log/staged-fs）" ⇒ 保留；两者皆无 ⇒ UNVERIFIABLE。

统计：KEEP(TS)=34　UNVERIFIABLE=4　VOID(armed=2,shimCount=0)=1　VOID(armed=4,shimCount=0)=2　VOID(no-shim)=6

| 运行目录 | 显式 tier | shim 产物 | 判定 |
|---|---|---|---|
| `docs/round10/fileio/evidence` | T1/TS | staged/fs | **KEEP(TS)** |
| `docs/round10/fileio/evidence/threads/run-1` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/fileio/evidence/threads/run-2` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/fileio/evidence/threads/run-2b` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/fileio/evidence/threads/run-2c` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/fileio/evidence/threads/run-4` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/fileio/evidence/threads/run-5` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/fileio/evidence/threads/run-5b` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/fix-npm/after-fix-13` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/fix-npm/after-fix-13c` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/fix-npm/before-fix` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/fix-npm/judge-proof-13c` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/fix-npm/midfix-r-boundary-02C7418F` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/threads/run-2` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/threads/run-3` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/threads/run-4` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/threads/run-5` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/threads/run-6` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/threads/run-7` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/threads/run-8` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/pkgs/evidence/threads/run-9` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/registry/evidence` | TS/T1 | staged/fs | **KEEP(TS)** |
| `docs/round10/registry/evidence/fix-r1/arm-13c` | TS | (none) | **KEEP(TS)** |
| `docs/round10/registry/evidence/fix-r1/repro-fixed2` | TS | (none) | **KEEP(TS)** |
| `docs/round10/registry/evidence/threads/run-burst2` | TS | (none) | **KEEP(TS)** |
| `docs/round10/registry/evidence/threads/run-isoA3` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/registry/evidence/threads/run-isoB3` | TS | (none) | **KEEP(TS)** |
| `docs/round10/registry/evidence/threads/run-seq2` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/shim/evidence` | TS/T1/T0 | staged/fs | **KEEP(TS)** |
| `docs/round10/shim/evidence/D37-dirface` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/shim/evidence/D38-dirface2` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/shim/evidence/D42-dirface-13c` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/shim/evidence/D43-dr1-e2e` | TS | staged/fs | **KEEP(TS)** |
| `docs/round10/fileio/evidence/fix/stage-after-wsreg` | (none) | (none) | **UNVERIFIABLE** |
| `docs/round10/fileio/evidence/fix/stage-before-wsreg` | (none) | (none) | **UNVERIFIABLE** |
| `docs/round10/fileio/evidence/threads/run-3` | (none) | (none) | **UNVERIFIABLE** |
| `docs/round10/fileio/evidence/threads/run-6-approval` | (none) | (none) | **UNVERIFIABLE** |
| `docs/round10/fileio/evidence/threads/VOID-run-1-defender-window` | T1 | staged/fs | **VOID(armed=2,shimCount=0)** |
| `docs/round10/pkgs/evidence/fix-npm/after-fix-13b` | T1 | staged/fs | **VOID(armed=4,shimCount=0)** |
| `docs/round10/shim/evidence/D40-dirface-13b` | T1 | staged/fs | **VOID(armed=4,shimCount=0)** |
| `docs/round10/fileio/evidence/threads/VOID-run-2-defender-window` | T1 | (none) | **VOID(no-shim)** |
| `docs/round10/pkgs/evidence/threads/run-1` | T1 | (none) | **VOID(no-shim)** |
| `docs/round10/registry/evidence/threads/run-burst` | T1 | (none) | **VOID(no-shim)** |
| `docs/round10/registry/evidence/threads/run-isoA` | T1 | (none) | **VOID(no-shim)** |
| `docs/round10/registry/evidence/threads/run-isoA2` | T1 | (none) | **VOID(no-shim)** |
| `docs/round10/registry/evidence/threads/run-isoB2` | T1 | (none) | **VOID(no-shim)** |