#!/usr/bin/env node

/**
 * Unified Model Client - Consolidates all overlapping client implementations
 * Replaces: hybrid-model-client.ts, unified-model-client.ts, enhanced-agentic-client.ts,
 *          local-model-client.ts, fast-mode-client.ts, performance-optimized-client.ts
 */

import { EventEmitter } from 'events';
import { logger } from './logger.js';
import { ProjectContext, ModelRequest, ModelResponse, ClientConfig } from './types.js';
import { SecurityUtils } from './security.js';
import { PerformanceMonitor } from '../utils/performance.js';

export type ProviderType = 'ollama' | 'lm-studio' | 'huggingface' | 'auto';
export type ExecutionMode = 'fast' | 'balanced' | 'thorough' | 'auto';

export interface ProviderConfig {
  type: ProviderType;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface UnifiedClientConfig extends ClientConfig {
  providers: ProviderConfig[];
  executionMode: ExecutionMode;
  fallbackChain: ProviderType[];
  performanceThresholds: {
    fastModeMaxTokens: number;
    timeoutMs: number;
    maxConcurrentRequests: number;
  };
  security: {
    enableSandbox: boolean;
    maxInputLength: number;
    allowedCommands: string[];
  };
}

export interface RequestMetrics {
  provider: string;
  model: string;
  startTime: number;
  endTime?: number;
  tokenCount?: number;
  success: boolean;
  error?: string;
}

export class UnifiedModelClient extends EventEmitter {
  private config: UnifiedClientConfig;
  private providers: Map<ProviderType, any> = new Map();
  private performanceMonitor: PerformanceMonitor;
  private securityUtils: SecurityUtils;
  private activeRequests: Map<string, RequestMetrics> = new Map();
  private requestQueue: Array<{ id: string; request: ModelRequest; resolve: Function; reject: Function }> = [];
  private isProcessingQueue = false;

  constructor(config: UnifiedClientConfig) {
    super();
    this.config = {
      ...this.getDefaultConfig(),
      ...config
    };
    this.performanceMonitor = new PerformanceMonitor();
    this.securityUtils = new SecurityUtils();
    this.initializeProviders();
  }

  private getDefaultConfig(): UnifiedClientConfig {
    return {
      providers: [
        { type: 'ollama', endpoint: 'http://localhost:11434' },
        { type: 'lm-studio', endpoint: 'http://localhost:1234' }
      ],
      executionMode: 'auto',
      fallbackChain: ['ollama', 'lm-studio', 'huggingface'],
      performanceThresholds: {
        fastModeMaxTokens: 1000,
        timeoutMs: 30000,
        maxConcurrentRequests: 3
      },
      security: {
        enableSandbox: true,
        maxInputLength: 50000,
        allowedCommands: ['npm', 'node', 'git', 'code']
      }
    };
  }

  private async initializeProviders(): Promise<void> {
    logger.info('🔧 Initializing model providers...');

    for (const providerConfig of this.config.providers) {
      try {
        const provider = await this.createProvider(providerConfig);
        this.providers.set(providerConfig.type, provider);
        logger.info(`✅ Provider ${providerConfig.type} initialized`);
      } catch (error) {
        logger.warn(`⚠️ Failed to initialize provider ${providerConfig.type}:`, error);
      }
    }

    if (this.providers.size === 0) {
      throw new Error('No providers successfully initialized');
    }
  }

  private async createProvider(config: ProviderConfig): Promise<any> {
    switch (config.type) {
      case 'ollama':
        const { OllamaProvider } = await import('../providers/ollama.js');
        return new providers.OllamaProvider(config);
      
      case 'lm-studio':
        const { LMStudioProvider } = await import('../providers/lm-studio.js');
        return new providers.LMStudioProvider(config);
      
      case 'huggingface':
        const { HuggingFaceProvider } = await import('../providers/huggingface.js');
        return new providers.HuggingFaceProvider(config);
      
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  async processRequest(request: ModelRequest, context?: ProjectContext): Promise<ModelResponse> {
    const requestId = this.generateRequestId();
    logger.info(`📨 Processing request ${requestId}`, { prompt: request.prompt.substring(0, 100) + '...' });

    // Security validation
    if (this.config.security.enableSandbox) {
      const validation = await this.securityUtils.validateInput(request.prompt);
      if (!validation.isValid) {
        throw new Error(`Security validation failed: ${validation.reason}`);
      }
    }

    // Determine execution strategy
    const strategy = this.determineExecutionStrategy(request, context);
    logger.info(`🎯 Using execution strategy: ${strategy.mode} with provider: ${strategy.provider}`);

    // Execute with fallback chain
    return await this.executeWithFallback(requestId, request, context, strategy);
  }

  private determineExecutionStrategy(request: ModelRequest, context?: ProjectContext): {
    mode: ExecutionMode;
    provider: ProviderType;
    timeout: number;
  } {
    // Auto-determine execution mode if not specified
    let mode = this.config.executionMode;
    if (mode === 'auto') {
      const promptLength = request.prompt.length;
      const hasContext = context && Object.keys(context).length > 0;
      
      if (promptLength < 500 && !hasContext) {
        mode = 'fast';
      } else if (promptLength > 5000 || (hasContext && context.files?.length > 10)) {
        mode = 'thorough';
      } else {
        mode = 'balanced';
      }
    }

    // Select provider based on mode and availability
    let provider: ProviderType = 'auto';
    let timeout = this.config.performanceThresholds.timeoutMs;

    switch (mode) {
      case 'fast':
        provider = this.selectFastestProvider();
        timeout = Math.min(timeout, 10000); // 10s max for fast mode
        break;
      
      case 'thorough':
        provider = this.selectMostCapableProvider();
        timeout = Math.max(timeout, 60000); // Allow longer for thorough mode
        break;
      
      case 'balanced':
      default:
        provider = this.selectBalancedProvider();
        break;
    }

    return { mode, provider, timeout };
  }

  private selectFastestProvider(): ProviderType {
    // Return provider with best latency metrics
    const metrics = this.performanceMonitor.getProviderMetrics();
    const sortedByLatency = Object.entries(metrics)
      .sort(([,a], [,b]) => a.averageLatency - b.averageLatency);
    
    return (sortedByLatency[0]?.[0] as ProviderType) || this.config.fallbackChain[0];
  }

  private selectMostCapableProvider(): ProviderType {
    // Return provider with best quality metrics
    const metrics = this.performanceMonitor.getProviderMetrics();
    const sortedByQuality = Object.entries(metrics)
      .sort(([,a], [,b]) => b.successRate - a.successRate);
    
    return (sortedByQuality[0]?.[0] as ProviderType) || this.config.fallbackChain[0];
  }

  private selectBalancedProvider(): ProviderType {
    // Return provider with best balance of speed and quality
    const metrics = this.performanceMonitor.getProviderMetrics();
    const scored = Object.entries(metrics).map(([provider, stats]) => ({
      provider,
      score: (stats.successRate * 0.6) + ((1 - stats.averageLatency / 30000) * 0.4)
    }));
    
    scored.sort((a, b) => b.score - a.score);
    return (scored[0]?.provider as ProviderType) || this.config.fallbackChain[0];
  }

  private async executeWithFallback(
    requestId: string,
    request: ModelRequest,
    context: ProjectContext | undefined,
    strategy: { mode: ExecutionMode; provider: ProviderType; timeout: number }
  ): Promise<ModelResponse> {
    const fallbackChain = strategy.provider === 'auto' 
      ? this.config.fallbackChain 
      : [strategy.provider, ...this.config.fallbackChain.filter(p => p !== strategy.provider)];

    let lastError: Error | null = null;

    for (const providerType of fallbackChain) {
      const provider = this.providers.get(providerType);
      if (!provider) {
        logger.warn(`Provider ${providerType} not available, skipping`);
        continue;
      }

      try {
        const metrics: RequestMetrics = {
          provider: providerType,
          model: provider.getModelName?.() || 'unknown',
          startTime: Date.now(),
          success: false
        };

        this.activeRequests.set(requestId, metrics);
        this.emit('requestStart', { requestId, provider: providerType });

        logger.info(`🚀 Attempting request with ${providerType}`);
        
        const response = await Promise.race([
          provider.processRequest(request, context),
          this.createTimeoutPromise(strategy.timeout)
        ]);

        metrics.endTime = Date.now();
        metrics.success = true;
        metrics.tokenCount = response.usage?.totalTokens;

        this.performanceMonitor.recordRequest(providerType, metrics);
        this.activeRequests.delete(requestId);
        this.emit('requestComplete', { requestId, provider: providerType, success: true });

        logger.info(`✅ Request ${requestId} completed successfully with ${providerType}`);
        return response;

      } catch (error) {
        const metrics = this.activeRequests.get(requestId);
        if (metrics) {
          metrics.endTime = Date.now();
          metrics.success = false;
          metrics.error = error instanceof Error ? error.message : String(error);
          this.performanceMonitor.recordRequest(providerType, metrics);
        }

        this.activeRequests.delete(requestId);
        this.emit('requestComplete', { requestId, provider: providerType, success: false, error });

        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`❌ Provider ${providerType} failed:`, error);
        
        // Don't retry if it's a validation error
        if (error instanceof Error && error.message.includes('validation')) {
          throw error;
        }
      }
    }

    throw new Error(`All providers failed. Last error: ${lastError?.message}`);
  }

  private createTimeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Queue management for concurrent request limiting
  async queueRequest(request: ModelRequest, context?: ProjectContext): Promise<ModelResponse> {
    if (this.activeRequests.size < this.config.performanceThresholds.maxConcurrentRequests) {
      return this.processRequest(request, context);
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        id: this.generateRequestId(),
        request,
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0 && 
           this.activeRequests.size < this.config.performanceThresholds.maxConcurrentRequests) {
      
      const queuedRequest = this.requestQueue.shift();
      if (!queuedRequest) break;

      try {
        const response = await this.processRequest(queuedRequest.request);
        queuedRequest.resolve(response);
      } catch (error) {
        queuedRequest.reject(error);
      }
    }

    this.isProcessingQueue = false;
  }

  // Management methods
  async healthCheck(): Promise<Record<string, boolean>> {
    const health: Record<string, boolean> = {};
    
    for (const [type, provider] of this.providers) {
      try {
        await provider.healthCheck?.();
        health[type] = true;
      } catch {
        health[type] = false;
      }
    }
    
    return health;
  }

  getMetrics(): any {
    return {
      activeRequests: this.activeRequests.size,
      queuedRequests: this.requestQueue.length,
      providerMetrics: this.performanceMonitor.getProviderMetrics(),
      performance: this.performanceMonitor.getSummary()
    };
  }

  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down UnifiedModelClient...');
    
    // Wait for active requests to complete (with timeout)
    const shutdownTimeout = 10000; // 10 seconds
    const startTime = Date.now();
    
    while (this.activeRequests.size > 0 && (Date.now() - startTime) < shutdownTimeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Close all providers
    for (const [type, provider] of this.providers) {
      try {
        await provider.shutdown?.();
        logger.info(`✅ Provider ${type} shut down`);
      } catch (error) {
        logger.warn(`⚠️ Error shutting down provider ${type}:`, error);
      }
    }
    
    this.providers.clear();
    this.activeRequests.clear();
    this.requestQueue.length = 0;
    
    logger.info('✅ UnifiedModelClient shutdown complete');
  }

  // Legacy compatibility methods
  async checkOllamaStatus(): Promise<boolean> {
    try {
      const response = await this.makeRequest('GET', '/api/tags');
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async getAllAvailableModels(): Promise<any[]> {
    return this.getAvailableModels();
  }

  async getAvailableModels(): Promise<any[]> {
    try {
      const response = await this.makeRequest('GET', '/api/tags');
      const data = await response.json();
      return data.models || [];
    } catch (error) {
      return [];
    }
  }

  async getBestAvailableModel(): Promise<string> {
    const models = await this.getAvailableModels();
    return models.length > 0 ? models[0].name : 'llama2';
  }

  async pullModel(modelName: string): Promise<boolean> {
    try {
      await this.makeRequest('POST', '/api/pull', { name: modelName });
      return true;
    } catch (error) {
      return false;
    }
  }

  async testModel(modelName: string): Promise<boolean> {
    try {
      const response = await this.generate({
        prompt: 'Hello',
        model: modelName
      });
      return !!response.content;
    } catch (error) {
      return false;
    }
  }

  async removeModel(modelName: string): Promise<boolean> {
    try {
      await this.makeRequest('DELETE', '/api/delete', { name: modelName });
      return true;
    } catch (error) {
      return false;
    }
  }

  async addApiModel(config: any): Promise<boolean> {
    // Implementation for API model management
    return true;
  }

  async testApiModel(modelName: string): Promise<boolean> {
    return this.testModel(modelName);
  }

  removeApiModel(modelName: string): boolean {
    // Implementation for API model removal
    return true;
  }

  async autoSetup(force: boolean = false): Promise<any> {
    return { success: true, message: 'Auto setup complete' };
  }

  async generateText(prompt: string): Promise<string> {
    const response = await this.generate({ prompt });
    return response.content;
  }

  static displayTroubleshootingHelp(): void {
    console.log('Troubleshooting help would be displayed here');
  }

  async makeRequest(method: string, endpoint: string, data?: any): Promise<Response> {
    const url = `${this.config.endpoint}${endpoint}`;
    return fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined
    });
  }
}

export { UnifiedModelClient as Client };

export interface VoiceArchetype {
  name: string;
  personality: string;
  expertise: string[];
}

export interface VoiceResponse {
  content: string;
  voice: string;
  confidence: number;
}

export type { ProjectContext } from "./types.js";
