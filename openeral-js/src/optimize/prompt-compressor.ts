/**
 * Compress prompts to reduce token usage
 */

import type { APIRequest, Message } from './types.js';

/**
 * Compress a prompt by removing redundant whitespace and content
 */
export function compressPrompt(request: APIRequest): APIRequest {
  const compressed = { ...request };

  // Compress messages
  compressed.messages = request.messages.map(msg => compressMessage(msg));

  // Compress system prompt
  if (typeof compressed.system === 'string') {
    compressed.system = compressText(compressed.system);
  }

  return compressed;
}

function compressMessage(message: Message): Message {
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: compressText(message.content),
    };
  }

  // Handle content blocks
  return {
    ...message,
    content: message.content.map(block => {
      if (block.type === 'text' && block.text) {
        return { ...block, text: compressText(block.text) };
      }
      return block;
    }),
  };
}

function compressText(text: string): string {
  let compressed = text;

  // Remove excessive newlines (3+ → 2)
  compressed = compressed.replace(/\n{3,}/g, '\n\n');

  // Remove excessive spaces (2+ → 1)
  compressed = compressed.replace(/  +/g, ' ');

  // Remove trailing whitespace from lines
  compressed = compressed.replace(/[ \t]+$/gm, '');

  // Truncate very long code blocks (keep first and last portions)
  compressed = truncateLongCodeBlocks(compressed);

  return compressed;
}

function truncateLongCodeBlocks(text: string): string {
  // Match code blocks (```...```)
  const codeBlockRegex = /```[\s\S]*?```/g;
  
  return text.replace(codeBlockRegex, (match) => {
    const lines = match.split('\n');
    
    // If code block is longer than 500 lines, truncate middle
    if (lines.length > 500) {
      const header = lines.slice(0, 3); // Keep language identifier
      const first = lines.slice(3, 203); // First 200 lines
      const last = lines.slice(-200); // Last 200 lines
      const truncated = [
        ...header,
        ...first,
        '// ... [truncated ' + (lines.length - 403) + ' lines for optimization] ...',
        ...last,
      ];
      return truncated.join('\n');
    }
    
    return match;
  });
}

/**
 * Calculate token savings from compression
 */
export function calculateTokenSavings(original: string, compressed: string): number {
  // Rough approximation: 1 token ≈ 4 characters
  const originalTokens = Math.ceil(original.length / 4);
  const compressedTokens = Math.ceil(compressed.length / 4);
  return Math.max(0, originalTokens - compressedTokens);
}

/**
 * Estimate total tokens in a request
 */
export function estimateRequestTokens(request: APIRequest): number {
  let total = 0;

  // System prompt
  if (typeof request.system === 'string') {
    total += Math.ceil(request.system.length / 4);
  } else if (Array.isArray(request.system)) {
    total += request.system.reduce((sum, msg) => sum + Math.ceil(msg.text.length / 4), 0);
  }

  // Messages
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    } else {
      total += msg.content.reduce((sum, block) => {
        return sum + (block.text ? Math.ceil(block.text.length / 4) : 0);
      }, 0);
    }
  }

  return total;
}
