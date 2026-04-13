/**
 * Analyze task complexity to determine optimal model
 */

import type { APIRequest, TaskAnalysis } from './types.js';

const FILE_OPERATION_PATTERNS = [
  /\bcat\b/i,
  /\bls\b/i,
  /\bread\s+file/i,
  /\blist\s+files/i,
  /\bshow\s+me/i,
  /\bview\s+file/i,
  /\bopen\s+file/i,
];

const CODE_EDIT_PATTERNS = [
  /\bedit\b/i,
  /\bmodify\b/i,
  /\bchange\b/i,
  /\bupdate\b/i,
  /\bfix\b/i,
  /\brefactor\b/i,
  /\badd\s+function/i,
  /\bremove\s+function/i,
];

const BASH_PATTERNS = [
  /\brun\b/i,
  /\bexecute\b/i,
  /\bcommand\b/i,
  /\bbash\b/i,
  /\bshell\b/i,
  /\bgrep\b/i,
  /\bfind\b/i,
];

const REASONING_PATTERNS = [
  /\barchitecture\b/i,
  /\bdesign\b/i,
  /\bexplain\s+why/i,
  /\bwhat\s+is\s+the\s+best/i,
  /\bhow\s+should\s+i/i,
  /\bcompare\b/i,
  /\banalyze\b/i,
  /\boptimize\b/i,
  /\brefactor\s+entire/i,
  /\brewrite\s+from\s+scratch/i,
];

/**
 * Analyze a task to determine its type and complexity
 */
export function analyzeTask(request: APIRequest): TaskAnalysis {
  const lastMessage = request.messages[request.messages.length - 1];
  if (!lastMessage) {
    return {
      type: 'unknown',
      complexity: 0.5,
      requiresDeepReasoning: false,
      estimatedTokens: 0,
    };
  }

  const content = typeof lastMessage.content === 'string'
    ? lastMessage.content
    : lastMessage.content.map(c => c.text || '').join(' ');

  // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
  const estimatedTokens = Math.ceil(content.length / 4);

  // Check for file operations
  if (FILE_OPERATION_PATTERNS.some(p => p.test(content))) {
    return {
      type: 'file_read',
      complexity: 0.1,
      requiresDeepReasoning: false,
      estimatedTokens,
    };
  }

  // Check for bash commands
  if (BASH_PATTERNS.some(p => p.test(content))) {
    return {
      type: 'bash',
      complexity: 0.2,
      requiresDeepReasoning: false,
      estimatedTokens,
    };
  }

  // Check for code editing
  if (CODE_EDIT_PATTERNS.some(p => p.test(content))) {
    return {
      type: 'code_edit',
      complexity: 0.5,
      requiresDeepReasoning: false,
      estimatedTokens,
    };
  }

  // Check for deep reasoning
  if (REASONING_PATTERNS.some(p => p.test(content))) {
    return {
      type: 'reasoning',
      complexity: 0.9,
      requiresDeepReasoning: true,
      estimatedTokens,
    };
  }

  // Default: moderate complexity
  return {
    type: 'unknown',
    complexity: 0.5,
    requiresDeepReasoning: false,
    estimatedTokens,
  };
}

/**
 * Select optimal model based on task analysis
 */
export function selectOptimalModel(task: TaskAnalysis, preferHaiku: boolean = false): string {
  // Simple file operations → Haiku (cheapest)
  if (task.type === 'file_read' || task.type === 'file_list') {
    return 'claude-3-5-haiku-20241022';
  }

  // Bash commands → Haiku
  if (task.type === 'bash' && !task.requiresDeepReasoning) {
    return 'claude-3-5-haiku-20241022';
  }

  // Complex reasoning → Opus
  if (task.requiresDeepReasoning || task.complexity > 0.8) {
    return 'claude-opus-4-20250514';
  }

  // Code editing → Sonnet (balanced)
  if (task.type === 'code_edit') {
    return 'claude-3-5-sonnet-20241022';
  }

  // Default: Sonnet (or Haiku if prefer flag is set)
  return preferHaiku ? 'claude-3-5-haiku-20241022' : 'claude-3-5-sonnet-20241022';
}
