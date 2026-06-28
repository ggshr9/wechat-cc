/**
 * wechat-mcp file tools — admin-only on-demand file locate over the owner's
 * computer. Registered ONLY for an admin-tier session (SESSION_IS_ADMIN gate in
 * main.ts). Thin wrapper over GET /v1/locate; same shape as the daemon tools.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerFileTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'locate_file',
    {
      title: 'Locate a file on the owner’s computer',
      description: '【管理员】在主人电脑的常用位置（桌面/文档/下载，加上你在 locations.md 里记过的目录）找文件。query=关键词；mode 默认 name（只匹配文件名/路径，快、不读内容），文件名找不到再用 mode=content（在内容里搜，慢）；mode=browse 列出某目录大致有什么。roots 可选：传你已知的绝对路径目录会优先搜。返回候选路径+大小+修改时间（不含文件内容）——选中后用 Read 打开，并把「这是什么 → 路径」记进 locations.md；都找不到就在微信问主人一句它一般放哪，再把那个目录记进 locations.md。',
      inputSchema: {
        query: z.string().optional().describe('关键词；mode=browse 时可省略'),
        mode: z.enum(['name', 'content', 'browse']).optional(),
        roots: z.array(z.string()).optional().describe('可选：已知的绝对路径目录，优先搜'),
      },
    },
    async ({ query, mode, roots }) => {
      try {
        const qs = new URLSearchParams()
        if (query) qs.set('q', query)
        if (mode) qs.set('mode', mode)
        for (const r of roots ?? []) qs.append('root', r)
        const r = await client.request<unknown>('GET', `/v1/locate${qs.toString() ? `?${qs}` : ''}`)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'locate_file')
      }
    },
  )
}
