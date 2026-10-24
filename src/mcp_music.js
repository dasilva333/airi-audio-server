const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

/**
 * MCP adapter over MusicService.
 *
 * This module owns transport and tool-schema concerns only. Every action
 * delegates to the same service the REST routes use, so there is exactly one
 * implementation of planning, rendering, job state, and library lookup.
 */

const SERVER_INFO = { name: 'airi-audio-server', version: '1.0.0' };

// The description is part of the prompt surface: it is what teaches the model to
// poll instead of assuming the receipt is the result.
const MUSIC_TOOL_DESCRIPTION = [
  'Plan and render original music through the AIRI audio server.',
  'Actions: "plan" writes an ABC notation score without rendering audio;',
  '"generate" renders a score or prompt into a finished track;',
  '"status" polls a plan or render job;',
  '"list" browses previously generated tracks;',
  '"cancel" cancels a job that has not started yet.',
  'plan and generate return a receipt immediately and never block,',
  'so always follow up with action="status" using the returned jobId.',
  'Check status at most once per turn: planning usually takes 3-20 seconds,',
  'and a 60 second render usually takes 1-3 minutes.',
  'Preferred flow: plan, show the ABC score to the user and discuss changes,',
  'then generate with the final abcScore.'
].join(' ');

const musicInputSchema = {
  action: z.enum(['plan', 'generate', 'status', 'list', 'cancel'])
    .describe('Which music operation to run. plan/generate return a job receipt; poll it with status.'),

  // Planning / rendering inputs
  prompt: z.string().optional()
    .describe('Style or genre description, e.g. "melodic synthwave, analog synths, driving bassline, 120 bpm".'),
  lyrics: z.string().optional()
    .describe('Structured lyrics with section tags, e.g. "[Verse]\\n...\\n[Chorus]\\n...". Leave empty for instrumental.'),
  title: z.string().optional()
    .describe('Human-readable title for the generated track.'),
  model: z.string().optional()
    .describe('Music model: "yue2" (default, 48 kHz score-first) or "minimax".'),
  durationSeconds: z.number().int().min(5).max(300).optional()
    .describe('Requested track length in seconds. Defaults to 60.'),
  cot: z.enum(['full', 'melody', 'off']).optional()
    .describe('Chain-of-thought depth for score planning. "full" is the best quality and the slowest.'),
  abcScore: z.string().optional()
    .describe('An ABC notation score to render, or to mutate when planning. Overrides prompt/lyrics derived structure.'),

  // Job addressing
  jobId: z.string().optional()
    .describe('The planId or jobId returned by plan/generate. Required for status and cancel.'),
  planId: z.string().optional()
    .describe('Alias for jobId when polling a plan.'),

  // Library search
  query: z.string().optional()
    .describe('Search text matched against track titles, models, and ABC scores for action="list".'),
  limit: z.number().int().min(1).max(50).optional()
    .describe('Maximum number of tracks to return for action="list". Defaults to 20.')
};

function toolError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }]
  };
}

function toolResult(payload) {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  };
}

/**
 * Maps the tool's action enum onto service calls.
 * Exported for tests; kept side-effect free apart from the service call itself.
 */
async function dispatchMusicAction(service, args = {}) {
  const action = String(args.action || '').toLowerCase();

  switch (action) {
    case 'plan':
      return service.startPlanJob(args);

    case 'generate':
      return service.startRenderJob(args);

    case 'status':
    case 'cancel': {
      const jobId = args.jobId || args.planId;
      if (!jobId) {
        throw new Error(`action="${action}" requires "jobId" (the jobId or planId returned by plan/generate).`);
      }
      return action === 'status' ? service.getJob(jobId) : service.cancelJob(jobId);
    }

    case 'list':
      return { tracks: service.listTracks({ query: args.query, limit: args.limit }) };

    default:
      throw new Error(`Unknown action "${args.action}". Use one of: plan, generate, status, list, cancel.`);
  }
}

function createMusicMcpServer(musicService) {
  const server = new McpServer(SERVER_INFO);

  server.registerTool('music', {
    title: 'Music',
    description: MUSIC_TOOL_DESCRIPTION,
    inputSchema: musicInputSchema
  }, async (args) => {
    try {
      const payload = await dispatchMusicAction(musicService, args);
      return toolResult(payload);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error(`[MCP] music tool error: ${message}`);
      return toolError(`Music tool failed: ${message}`);
    }
  });

  return server;
}

/**
 * Mounts the stateless Streamable HTTP endpoint on the existing Express app.
 *
 * Stateless: one server+transport per request, no session IDs, JSON responses
 * instead of SSE streams. That matches how AIRI's MCP client calls tools and
 * avoids holding response streams open for long-running tool calls.
 */
function mountMusicMcp(app, musicService, options = {}) {
  const logger = options.logger || console;

  const handleRequest = async (req, res) => {
    if (req.get('host')) {
      // Audio URLs in tool results are built from this, so they point back at the
      // host the client actually reached (localhost or LAN).
      musicService.setPublicBaseUrl(`${req.protocol}://${req.get('host')}`);
    }

    const server = createMusicMcpServer(musicService);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error(`[MCP] request failed: ${error && error.stack ? error.stack : error}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal MCP error' }
        });
      }
    }
  };

  app.post('/mcp', handleRequest);

  // Stateless mode exposes no SSE stream; say so explicitly rather than hanging.
  const methodNotAllowed = (req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method Not Allowed. Stateless Streamable HTTP is exposed on POST /mcp only.' }
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

module.exports = {
  SERVER_INFO,
  MUSIC_TOOL_DESCRIPTION,
  musicInputSchema,
  dispatchMusicAction,
  createMusicMcpServer,
  mountMusicMcp
};
