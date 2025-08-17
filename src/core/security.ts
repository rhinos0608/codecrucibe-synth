#!/usr/bin/env node

/**
 * Security Utilities - Consolidated security functions
 * Replaces: security-utils.ts and scattered security code
 */

import { createHash, randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { resolve, normalize } from 'path';
import { logger } from './logger.js';
import { SecurityValidation, SecurityError } from './types.js';

export interface SecurityConfig {
  enableSandbox: boolean;
  maxInputLength: number;
  allowedCommands: string[];
  allowedPaths: string[];
  blockedPatterns: RegExp[];
  scanDependencies: boolean;
  enableCSPProtection: boolean;
}

export class SecurityUtils {
  private config: SecurityConfig;
  private blockedPatterns: RegExp[];
  private allowedCommands: Set<string>;

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = {
      enableSandbox: true,
      maxInputLength: 50000,
      allowedCommands: ['npm', 'node', 'git', 'code', 'tsc', 'eslint'],
      allowedPaths: [process.cwd()],
      blockedPatterns: [
        /rm\s+-rf/gi,          // Dangerous delete commands
        /sudo\s+/gi,           // Privilege escalation
        /eval\s*\(/gi,         // Code evaluation
        /exec\s*\(/gi,         // Code execution
        /system\s*\(/gi,       // System calls
        /shell_exec/gi,        // Shell execution
        /file_get_contents/gi, // File access
        /fopen\s*\(/gi,        // File operations
        /curl\s+.*\|\s*sh/gi,  // Remote execution
        /wget\s+.*\|\s*sh/gi,  // Remote execution
      ],
      scanDependencies: true,
      enableCSPProtection: true,
      ...config
    };

    this.blockedPatterns = this.config.blockedPatterns;
    this.allowedCommands = new Set(this.config.allowedCommands);
  }

  /**
   * Validate user input for security threats
   */
  async validateInput(input: string): Promise<SecurityValidation> {
    try {
      // Check input length
      if (input.length > this.config.maxInputLength) {
        return {
          isValid: false,
          reason: `Input exceeds maximum length of ${this.config.maxInputLength} characters`,
          riskLevel: 'medium'
        };
      }

      // Check for blocked patterns
      for (const pattern of this.blockedPatterns) {
        if (pattern.test(input)) {
          logger.warn('🚨 Blocked potentially dangerous input pattern', { pattern: pattern.source });
          return {
            isValid: false,
            reason: `Input contains potentially dangerous pattern: ${pattern.source}`,
            riskLevel: 'high'
          };
        }
      }

      // Check for suspicious file operations
      const suspiciousFileOps = [
        /\.\.\//, // Directory traversal
        /\/etc\/passwd/, // System files
        /\/proc\//, // Process information
        /\/sys\//, // System information
        /C:\\Windows\\/, // Windows system
        /\/bin\//, // System binaries
      ];

      for (const pattern of suspiciousFileOps) {
        if (pattern.test(input)) {
          return {
            isValid: false,
            reason: 'Input contains suspicious file operation patterns',
            riskLevel: 'high'
          };
        }
      }

      // Sanitize and validate
      const sanitizedInput = this.sanitizeInput(input);
      
      return {
        isValid: true,
        sanitizedInput,
        riskLevel: 'low'
      };

    } catch (error) {
      logger.error('Error validating input:', error);
      return {
        isValid: false,
        reason: 'Input validation failed',
        riskLevel: 'high'
      };
    }
  }

  /**
   * Sanitize user input
   */
  private sanitizeInput(input: string): string {
    // Remove null bytes
    let sanitized = input.replace(/\0/g, '');
    
    // Normalize line endings
    sanitized = sanitized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Limit consecutive newlines
    sanitized = sanitized.replace(/\n{5,}/g, '\n\n\n\n');
    
    // Remove or escape potentially dangerous sequences
    sanitized = sanitized.replace(/`{3,}/g, '```'); // Limit code blocks
    
    return sanitized.trim();
  }

  /**
   * Validate command execution
   */
  async validateCommand(command: string, args: string[] = []): Promise<SecurityValidation> {
    const baseCommand = command.split(' ')[0];
    
    if (!this.allowedCommands.has(baseCommand)) {
      return {
        isValid: false,
        reason: `Command '${baseCommand}' is not in the allowed commands list`,
        riskLevel: 'high'
      };
    }

    // Check for command injection patterns
    const fullCommand = `${command} ${args.join(' ')}`;
    const injectionPatterns = [
      /[;&|`$(){}]/,  // Command separators and substitution
      />\s*\/dev\//, // Redirecting to device files
      /\|\s*sh/,     // Piping to shell
      /\|\s*bash/,   // Piping to bash
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(fullCommand)) {
        return {
          isValid: false,
          reason: 'Command contains potential injection patterns',
          riskLevel: 'high'
        };
      }
    }

    return {
      isValid: true,
      riskLevel: 'low'
    };
  }

  /**
   * Validate file path for access
   */
  async validatePath(filePath: string): Promise<SecurityValidation> {
    try {
      const normalizedPath = normalize(resolve(filePath));
      
      // Check if path is within allowed directories
      const isAllowed = this.config.allowedPaths.some(allowedPath => {
        const normalizedAllowed = normalize(resolve(allowedPath));
        return normalizedPath.startsWith(normalizedAllowed);
      });

      if (!isAllowed) {
        return {
          isValid: false,
          reason: 'Path is outside allowed directories',
          riskLevel: 'high'
        };
      }

      // Check for directory traversal
      if (filePath.includes('..') || filePath.includes('~')) {
        return {
          isValid: false,
          reason: 'Path contains directory traversal patterns',
          riskLevel: 'high'
        };
      }

      // Check for system file access
      const systemPaths = [
        '/etc', '/proc', '/sys', '/dev',
        'C:\\Windows', 'C:\\System32'
      ];

      for (const systemPath of systemPaths) {
        if (normalizedPath.startsWith(systemPath)) {
          return {
            isValid: false,
            reason: 'Attempted access to system directories',
            riskLevel: 'high'
          };
        }
      }

      return {
        isValid: true,
        riskLevel: 'low'
      };

    } catch (error) {
      return {
        isValid: false,
        reason: 'Path validation failed',
        riskLevel: 'medium'
      };
    }
  }

  /**
   * Execute command in sandbox
   */
  async executeSecurely(
    command: string,
    args: string[] = [],
    options: { timeout?: number; cwd?: string } = {}
  ): Promise<{ success: boolean; output: string; error?: string }> {
    
    if (!this.config.enableSandbox) {
      throw new SecurityError('Sandbox execution is disabled');
    }

    // Validate command
    const commandValidation = await this.validateCommand(command, args);
    if (!commandValidation.isValid) {
      throw new SecurityError(`Command validation failed: ${commandValidation.reason}`);
    }

    // Validate working directory
    if (options.cwd) {
      const pathValidation = await this.validatePath(options.cwd);
      if (!pathValidation.isValid) {
        throw new SecurityError(`Working directory validation failed: ${pathValidation.reason}`);
      }
    }

    return new Promise((resolve) => {
      const timeout = options.timeout || 30000;
      let output = '';
      let error = '';

      const child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        // Add additional security constraints
        env: {
          PATH: process.env.PATH,
          NODE_ENV: process.env.NODE_ENV || 'production'
        }
      });

      child.stdout?.on('data', (data) => {
        output += data.toString();
      });

      child.stderr?.on('data', (data) => {
        error += data.toString();
      });

      child.on('close', (code) => {
        resolve({
          success: code === 0,
          output: output.trim(),
          error: error.trim() || undefined
        });
      });

      child.on('error', (err) => {
        resolve({
          success: false,
          output: '',
          error: err.message
        });
      });

      // Kill process if it exceeds timeout
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }
      }, timeout);
    });
  }

  /**
   * Scan dependencies for known vulnerabilities
   */
  async scanDependencies(packageJsonPath: string): Promise<{
    vulnerabilities: Array<{
      package: string;
      version: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      description: string;
      recommendation: string;
    }>;
    riskLevel: 'low' | 'medium' | 'high';
  }> {
    if (!this.config.scanDependencies) {
      return { vulnerabilities: [], riskLevel: 'low' };
    }

    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };

      const vulnerabilities = [];
      
      // Known problematic packages
      const knownIssues = {
        'vm2': {
          severity: 'high' as const,
          description: 'vm2 is deprecated and has known security vulnerabilities',
          recommendation: 'Use isolated-vm or proper sandboxing alternatives'
        },
        'lodash': {
          severity: 'medium' as const,
          description: 'Some versions of lodash have prototype pollution vulnerabilities',
          recommendation: 'Update to latest version or use lodash-es'
        }
      };

      for (const [pkg, version] of Object.entries(dependencies)) {
        if (pkg in knownIssues) {
          vulnerabilities.push({
            package: pkg,
            version: version as string,
            ...knownIssues[pkg as keyof typeof knownIssues]
          });
        }
      }

      // Determine overall risk level
      const riskLevel = vulnerabilities.some(v => v.severity === 'high')
        ? 'high'
        : vulnerabilities.some(v => v.severity === 'medium')
        ? 'medium'
        : 'low';

      return { vulnerabilities, riskLevel };

    } catch (error) {
      logger.error('Error scanning dependencies:', error);
      return { vulnerabilities: [], riskLevel: 'medium' };
    }
  }

  /**
   * Generate secure random token
   */
  generateSecureToken(length: number = 32): string {
    return randomBytes(length).toString('hex');
  }

  /**
   * Hash sensitive data
   */
  hashSensitiveData(data: string, salt?: string): string {
    const actualSalt = salt || randomBytes(16).toString('hex');
    return createHash('sha256').update(data + actualSalt).digest('hex');
  }

  /**
   * Validate API key format
   */
  validateApiKey(apiKey: string): boolean {
    // Basic validation - should be alphanumeric and reasonable length
    const apiKeyPattern = /^[A-Za-z0-9_-]{16,128}$/;
    return apiKeyPattern.test(apiKey);
  }

  /**
   * Apply Content Security Policy headers for web interfaces
   */
  getCSPHeaders(): Record<string, string> {
    if (!this.config.enableCSPProtection) {
      return {};
    }

    return {
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "font-src 'self'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'"
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
  }

  /**
   * Update security configuration
   */
  updateConfig(newConfig: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.allowedCommands = new Set(this.config.allowedCommands);
    this.blockedPatterns = this.config.blockedPatterns;
    logger.info('🔒 Security configuration updated');
  }

  /**
   * Get current security configuration (sanitized)
   */
  getConfig(): Omit<SecurityConfig, 'blockedPatterns'> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { blockedPatterns, ...config } = this.config;
    return config;
  }
}
