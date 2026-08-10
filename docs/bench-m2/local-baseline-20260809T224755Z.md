# workspace-bench: local-baseline (20260809T224755Z)

- host: `kbs` · fs: `ext4 /dev/nvme0n1p1` · target: `/home/kbs/bench/local-baseline`
- second mount: `/home/kbs/bench/local-baseline`
- overall: **PASS**

| stage | status | key figures |
|---|---|---|
| pjdfstest | PASS | 6791 tests / 155 files (86778ms) @ 85a8aea9 |
| fio | PASS | randrw4k r:12807iops/50MBps w:12812iops/50MBps · seqwrite1m r:0iops/0MBps w:3160iops/3160MBps · seqread1m r:6400iops/6400MBps w:0iops/0MBps |
| git | PASS | clone 333ms · 20 commits 903ms · rebase 207ms · gc 125ms · fsck 59ms · hash match |
| coherence | PASS | visible 10ms · delete 9ms · recreate 10ms |
