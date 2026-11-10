import { describe, expect, it } from 'vitest'
import { contextPartZh, detectFolders, findTrigger, formatClock, formatTokens, markdownToPlain, relativeTimeZh, resetTimeZh, sessionTitle, toolSummary } from '../src/shared/format'

describe('relativeTimeZh', () => {
  const now = new Date(2026, 9, 30, 15, 0).getTime()
  const at = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min).getTime()

  it('一分钟内显示刚刚', () => expect(relativeTimeZh(now - 30_000, now)).toBe('刚刚'))
  it('一小时内显示分钟', () => expect(relativeTimeZh(now - 5 * 60_000, now)).toBe('5 分钟前'))
  it('今天显示小时', () => expect(relativeTimeZh(at(2026, 10, 30, 9), now)).toBe('6 小时前'))
  it('昨天', () => expect(relativeTimeZh(at(2026, 10, 29, 23), now)).toBe('昨天'))
  it('一周内显示天数', () => expect(relativeTimeZh(at(2026, 10, 27), now)).toBe('3 天前'))
  it('今年更早显示月日', () => expect(relativeTimeZh(at(2026, 10, 12), now)).toBe('10月12日'))
  it('往年显示年月日', () => expect(relativeTimeZh(at(2025, 3, 1), now)).toBe('2025年3月1日'))
  it('未来时间按刚刚处理', () => expect(relativeTimeZh(now + 60_000, now)).toBe('刚刚'))
})

describe('sessionTitle', () => {
  it('优先用自定义标题', () =>
    expect(sessionTitle({ customTitle: '我的会话', summary: '摘要', firstPrompt: '第一句' })).toBe('我的会话'))
  it('其次用摘要', () => expect(sessionTitle({ summary: '摘要', firstPrompt: '第一句' })).toBe('摘要'))
  it('再次用第一句话并压缩空白', () => expect(sessionTitle({ firstPrompt: '  你好\n  世界 ' })).toBe('你好 世界'))
  it('uses the task after file references, or filenames when only files were supplied', () => {
    expect(sessionTitle({ firstPrompt: '@C:/Users/me/file.md\n\n请检查内容' })).toBe('请检查内容')
    expect(sessionTitle({ firstPrompt: '@"C:/my files/one.md"\n@C:/two.txt' })).toBe('one.md、two.txt')
    expect(sessionTitle({ summary: '@C:/temporary/example.md  请检查这个文件', firstPrompt: '@C:/temporary/example.md  请检查这个文件' })).toBe('请检查这个文件')
    expect(sessionTitle({ firstPrompt: '@Dockerfile\n\n请检查构建配置' })).toBe('请检查构建配置')
    expect(sessionTitle({ summary: '@Dockerfile @Makefile 检查构建', firstPrompt: '@Dockerfile @Makefile 检查构建' })).toBe('检查构建')
    expect(sessionTitle({ firstPrompt: '@Makefile' })).toBe('Makefile')
    expect(sessionTitle({ firstPrompt: '@alice 请检查这个任务' })).toBe('@alice 请检查这个任务')
    expect(sessionTitle({ firstPrompt: '@team\n\n请检查这个任务' })).toBe('@team 请检查这个任务')
    expect(sessionTitle({ customTitle: '手动', summary: 'CLI 标题', firstPrompt: '@x.md\n任务' })).toBe('手动')
  })
  it('过长时截断', () => expect(sessionTitle({ firstPrompt: 'a'.repeat(100) })).toBe('a'.repeat(80) + '…'))
  it('都没有时显示未命名', () => expect(sessionTitle({ summary: '  ' })).toBe('未命名会话'))
})

describe('detectFolders', () => {
  const home = '/Users/me'
  const exists = (p: string): boolean => !p.includes('gone')
  it('按会话数排序并排除 ~/.claude、临时目录和已不存在的目录', () => {
    const sessions = [
      { cwd: '/Users/me' },
      { cwd: '/Users/me' },
      { cwd: '/Users/me/Desktop/调研' },
      { cwd: '/Users/me/.claude/projects/x' },
      { cwd: '/private/var/folders/ab/T/probe' },
      { cwd: '/tmp/x' },
      { cwd: '/Users/me/gone' },
      { cwd: undefined }
    ]
    expect(detectFolders(sessions, home, exists)).toEqual([
      { path: '/Users/me', sessionCount: 2 },
      { path: '/Users/me/Desktop/调研', sessionCount: 1 }
    ])
  })
})

describe('toolSummary', () => {
  const cwd = '/Users/me/proj'
  it('项目内的文件显示相对路径', () => {
    expect(toolSummary('Write', { file_path: '/Users/me/proj/src/a.ts' }, cwd)).toBe('src/a.ts')
  })
  it('项目外的文件保留完整路径', () => {
    expect(toolSummary('Read', { file_path: '/Users/me/projX/a.ts' }, cwd)).toBe('/Users/me/projX/a.ts')
  })
  it('命令优先显示说明', () => {
    expect(toolSummary('Bash', { command: 'ls', description: '列出文件' }, cwd)).toBe('列出文件')
  })
})

describe('findTrigger', () => {
  it('开头的 / 触发命令', () => {
    expect(findTrigger('/com', 4)).toEqual({ kind: '/', start: 0, query: 'com' })
  })
  it('句中的 / 不触发命令', () => {
    expect(findTrigger('看 src/main', 10)).toBeNull()
  })
  it('空格后的 @ 触发文件引用', () => {
    expect(findTrigger('看看 @src/ma', 10)).toEqual({ kind: '@', start: 3, query: 'src/ma' })
  })
  it('邮箱里的 @ 不触发', () => {
    expect(findTrigger('a@b', 3)).toBeNull()
  })
  it('光标后面的内容不影响', () => {
    expect(findTrigger('@ab cd', 3)).toEqual({ kind: '@', start: 0, query: 'ab' })
  })
})

describe('formatTokens', () => {
  it('小于一万直接显示，带千分位', () => {
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(9_999)).toBe('9,999')
  })
  it('一万以上以「万」为单位，保留一位小数并去掉多余的 0', () => {
    expect(formatTokens(38_482)).toBe('3.8 万')
    expect(formatTokens(200_000)).toBe('20 万')
    expect(formatTokens(1_000_000)).toBe('100 万')
  })
})

describe('contextPartZh', () => {
  it('翻译已知类别，未知的保持原样', () => {
    expect(contextPartZh('System prompt')).toBe('系统提示词')
    expect(contextPartZh('Messages')).toBe('对话消息')
    expect(contextPartZh('Something new')).toBe('Something new')
  })
})

describe('resetTimeZh', () => {
  const now = new Date(2026, 9, 30, 22, 0).getTime()
  it('一小时内只显示分钟', () => {
    expect(resetTimeZh(new Date(2026, 9, 30, 22, 45).toISOString(), now)).toBe('45 分钟后重置')
  })
  it('一天内显示小时和分钟', () => {
    expect(resetTimeZh(new Date(2026, 9, 31, 0, 30).toISOString(), now)).toBe('2 小时 30 分钟后重置')
    expect(resetTimeZh(new Date(2026, 9, 31, 3, 0).toISOString(), now)).toBe('5 小时后重置')
  })
  it('更远的显示日期、星期和时间', () => {
    expect(resetTimeZh(new Date(2026, 10, 3, 1, 0).toISOString(), now)).toBe('11月3日（周二）01:00 重置')
  })
  it('已经过了或没有时间', () => {
    expect(resetTimeZh(new Date(2026, 9, 30, 21, 0).toISOString(), now)).toBe('即将重置')
    expect(resetTimeZh(null, now)).toBe('')
  })
})

describe('formatClock / markdownToPlain', () => {
  it('今天只显示时分，更早的带日期', () => {
    const now = new Date(2026, 9, 31, 12, 0).getTime()
    expect(formatClock(new Date(2026, 9, 31, 11, 56).getTime(), now)).toBe('11:56')
    expect(formatClock(new Date(2026, 9, 30, 9, 5).getTime(), now)).toBe('10月30日 09:05')
    expect(formatClock(new Date(2025, 0, 2, 9, 5).getTime(), now)).toBe('2025年1月2日 09:05')
  })

  it('去掉 Markdown 标记，表格变成制表符分隔', () => {
    const md = '## 结果\n\n还有 **4 人**未填写，见 [名单](a.md) 和 `成绩.xlsx`：\n\n| 姓名 | 学号 |\n|---|---|\n| 蔡浩鑫 | 26216877 |\n\n> 注意 *请假* 的同学'
    expect(markdownToPlain(md)).toBe('结果\n\n还有 4 人未填写，见 名单 和 成绩.xlsx：\n\n姓名\t学号\n蔡浩鑫\t26216877\n\n注意 请假 的同学')
  })
})
