/*
 * fullscreen-watch —— 报告哪些显示器正显示别的应用的全屏窗口（macOS，给 ../fullscreen-guard.js 用）。
 *
 * 用法：fullscreen-watch <自身 pid> [轮询毫秒]
 * 每次结果变化（以及启动时）往 stdout 写一行 JSON：[[x,y,w,h],...]，坐标为 Quartz 全局坐标
 * （点，主屏左上为原点，与 Electron screen 坐标同系）。父进程消失即退出。
 *
 * 判定与白龙桌宠的 FullScreenGuard 相同：普通桌面保留菜单栏，只有全屏 Space 才会让一个
 * layer 0 窗口恰好盖满整块屏；/System/Library 下的系统进程（AquaAppearanceHelper 切换深浅色时
 * 会短暂盖满所有屏）不算。只读窗口的 bounds / layer / pid，不需要屏幕录制权限。
 *
 * 构建：tools/macos/build_macos.py 用 xcrun clang 编译进 app。
 */
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_DISPLAYS 16
#define OWNER_CACHE 256

static struct { pid_t pid; int system; } owners[OWNER_CACHE];
static int owner_count;

static int system_owner(pid_t pid) {
  for (int i = 0; i < owner_count; i++)
    if (owners[i].pid == pid) return owners[i].system;
  if (owner_count == OWNER_CACHE) owner_count = 0; /* pid 会被复用，缓存满了就重来 */
  char path[PROC_PIDPATHINFO_MAXSIZE];
  int system = proc_pidpath(pid, path, sizeof path) > 0 && strncmp(path, "/System/Library/", 16) == 0;
  owners[owner_count].pid = pid;
  owners[owner_count].system = system;
  owner_count++;
  return system;
}

static int number(CFDictionaryRef info, CFStringRef key, long long *out) {
  CFNumberRef value = CFDictionaryGetValue(info, key);
  return value && CFGetTypeID(value) == CFNumberGetTypeID() && CFNumberGetValue(value, kCFNumberLongLongType, out);
}

/* 把正显示全屏窗口的显示器写进 line；返回 0 表示这一轮读不到（保持上一次结果） */
static int scan(pid_t own, char *line, size_t size) {
  CGDirectDisplayID ids[MAX_DISPLAYS];
  uint32_t count = 0;
  if (CGGetActiveDisplayList(MAX_DISPLAYS, ids, &count) != kCGErrorSuccess) return 0;
  CGRect displays[MAX_DISPLAYS];
  int found[MAX_DISPLAYS] = {0};
  for (uint32_t i = 0; i < count; i++) displays[i] = CGDisplayBounds(ids[i]);

  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!windows) return 0;
  for (CFIndex i = 0, n = CFArrayGetCount(windows); i < n; i++) {
    CFDictionaryRef info = CFArrayGetValueAtIndex(windows, i);
    long long layer, pid;
    CGRect rect;
    if (!number(info, kCGWindowLayer, &layer) || layer != 0) continue;
    if (!number(info, kCGWindowOwnerPID, &pid) || pid == own) continue;
    CFDictionaryRef bounds = CFDictionaryGetValue(info, kCGWindowBounds);
    if (!bounds || !CGRectMakeWithDictionaryRepresentation(bounds, &rect)) continue;
    for (uint32_t d = 0; d < count; d++) {
      if (found[d] || !CGRectEqualToRect(rect, displays[d])) continue;
      if (system_owner((pid_t)pid)) break;
      found[d] = 1;
    }
  }
  CFRelease(windows);

  size_t used = (size_t)snprintf(line, size, "[");
  for (uint32_t d = 0, first = 1; d < count && used < size; d++) {
    if (!found[d]) continue;
    CGRect r = displays[d];
    used += (size_t)snprintf(line + used, size - used, "%s[%g,%g,%g,%g]", first ? "" : ",", r.origin.x, r.origin.y, r.size.width, r.size.height);
    first = 0;
  }
  if (used < size) snprintf(line + used, size - used, "]");
  return 1;
}

int main(int argc, char **argv) {
  pid_t own = argc > 1 ? (pid_t)atoi(argv[1]) : 0;
  int interval = argc > 2 ? atoi(argv[2]) : 800;
  if (interval < 100) interval = 100;
  pid_t parent = getppid();
  char line[2048], last[2048] = "";
  for (;;) {
    if (getppid() != parent) return 0; /* helper 退出后被 launchd 收养：跟着退 */
    if (scan(own, line, sizeof line) && strcmp(line, last) != 0) {
      if (printf("%s\n", line) < 0 || fflush(stdout) != 0) return 0; /* 管道断了 = helper 没了 */
      strcpy(last, line);
    }
    usleep((useconds_t)interval * 1000);
  }
}
