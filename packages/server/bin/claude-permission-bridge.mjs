#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const apiUrl = process.env.RCA_CLAUDE_PERMISSION_API_URL;
const apiToken = process.env.RCA_CLAUDE_PERMISSION_API_TOKEN;
const threadId = process.env.RCA_CLAUDE_THREAD_ID;

if (!apiUrl || !apiToken || !threadId) {
  console.error('Claude permission bridge is missing required RCA_* environment variables.');
  process.exit(1);
}

const server = new McpServer({
  name: 'rca-claude-permission-bridge',
  version: '0.1.0',
});

server.registerTool(
  'rca_approve_permission',
  {
    description: 'Routes Claude Code permission prompts to the RCA approval UI.',
    inputSchema: {
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()).optional(),
      tool_use_id: z.string(),
    },
  },
  async ({ tool_name: toolName, input, tool_use_id: toolUseId }) => {
    const normalizedInput = input || {};
    const decision = await requestPermission({
      toolName,
      input: normalizedInput,
      toolUseId,
    });

    const normalizedDecision = decision.behavior === 'allow'
      ? {
        ...decision,
        updatedInput: decision.updatedInput || normalizedInput,
      }
      : decision;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(normalizedDecision),
        },
      ],
    };
  },
);

async function requestPermission({ toolName, input, toolUseId }) {
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rca-internal-token': apiToken,
      },
      body: JSON.stringify({
        threadId,
        toolName,
        input,
        toolUseId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        behavior: 'deny',
        message: text || `Permission bridge request failed with ${response.status}.`,
        toolUseID: toolUseId,
      };
    }

    const payload = await response.json();
    if (!payload || (payload.behavior !== 'allow' && payload.behavior !== 'deny')) {
      return {
        behavior: 'deny',
        message: 'Permission bridge returned an invalid response.',
        toolUseID: toolUseId,
      };
    }

    return {
      ...payload,
      toolUseID: payload.toolUseID || toolUseId,
    };
  } catch (error) {
    return {
      behavior: 'deny',
      message: error instanceof Error ? error.message : 'Permission bridge request failed.',
      toolUseID: toolUseId,
    };
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
