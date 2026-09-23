// One eval at a time.
//
// Three measurements tonight were quietly ruined by a second process sharing this machine's
// proxy: the calls start failing with "could not reach the provider" halfway through, which
// reads exactly like a model failure and is not. The numbers looked real and were not.
//
// A directory is the atomic primitive every filesystem agrees on, so that is the lock. It is
// taken explicitly by whatever is being RUN, never on import - a tool that imports another
// tool's helpers must not trip over a lock it never wanted.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LOCK = join(tmpdir(), "gatecraft-eval.lock");

export function takeLock() {
  try {
    mkdirSync(LOCK);
  } catch {
    console.error(`另一个评测正在跑（锁在 ${LOCK}）。`);
    console.error("同时跑两个会争代理，中途的网络错误会被当成模型失败——今晚已经毁掉三轮数据。");
    console.error("确认没有别的评测进程后，删掉那个目录再跑。");
    process.exit(1);
  }
  const unlock = () => {
    try {
      rmSync(LOCK, { recursive: true, force: true });
    } catch {}
  };
  process.on("exit", unlock);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { unlock(); process.exit(130); });
}
