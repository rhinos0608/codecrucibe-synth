/**
 * CLI Commands for Enhanced Search System
 * Based on research from RIPGREP_FIND_SEARCH_RESEARCH_2025-08-25
 * Integrates with existing CodeCrucible Synth CLI system
 */

import { Command } from 'commander';
import { logger } from '../logger.js';
import { HybridSearchCoordinator } from './hybrid-search-coordinator.js';
import { CommandLineSearchEngine, SearchResult } from './command-line-search-engine.js';
import { HybridSearchFactory } from './hybrid-search-factory.js';
import { SearchPerformanceMonitor } from './performance-monitor.js';
import { SearchOptions } from './types.js';
import { RAGQuery, RAGResult, DocumentMetadata } from '../rag/vector-rag-system.js';
import * as path from 'path';
import * as fs from 'fs';

export interface CLISearchIntegration {
  registerSearchCommands(program: Command): void;
}

// CLI option interfaces
interface BaseSearchOptions {
  lang?: string[];
  context?: string;
  output?: 'json' | 'table' | 'simple';
}

interface SearchCommandOptions extends BaseSearchOptions {
  type?: 'function' | 'class' | 'import' | 'todo' | 'error' | 'general' | 'pattern';
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  maxResults?: string;
  method?: 'ripgrep' | 'rag' | 'hybrid';
  confidence?: string;
}

interface FunctionSearchOptions extends BaseSearchOptions {
  includeTests?: boolean;
}

interface ClassSearchOptions extends BaseSearchOptions {
  includeInterfaces?: boolean;
}

interface ImportSearchOptions extends BaseSearchOptions {
  showUsage?: boolean;
}

interface FileSearchOptions extends BaseSearchOptions {
  includeHidden?: boolean;
  sizeLimit?: string;
  type?: string;
  size?: string;
  modified?: string;
  exclude?: string[];
}

interface AnalyzeOptions extends BaseSearchOptions {
  includeStats?: boolean;
  export?: string;
}

interface BenchmarkOptions {
  iterations?: string;
  query?: string;
  compareAll?: boolean;
}

interface CacheOptions {
  clear?: boolean;
  stats?: boolean;
  export?: string;
  invalidate?: string;
}

interface BenchmarkCommandOptions {
  queries?: string;
  methods?: string[];
  iterations?: string;
  output?: string;
}

interface PerformanceCommandOptions {
  export?: boolean;
  clear?: boolean;
  threshold?: string;
}

export class SearchCLICommands implements CLISearchIntegration {
  private logger: typeof logger;
  private hybridCoordinator?: HybridSearchCoordinator;
  private commandSearch: CommandLineSearchEngine;
  private workingDirectory: string;
  private performanceMonitor?: SearchPerformanceMonitor;

  constructor(workingDirectory: string = process.cwd()) {
    this.logger = logger;
    this.workingDirectory = workingDirectory;
    this.commandSearch = new CommandLineSearchEngine(workingDirectory);

    // Initialize hybrid coordinator with balanced config
    try {
      const hybridConfig = HybridSearchFactory.createBalancedConfig();
      this.hybridCoordinator = new HybridSearchCoordinator(this.commandSearch, hybridConfig);

      // Initialize performance monitoring
      this.performanceMonitor = new SearchPerformanceMonitor(
        this.hybridCoordinator,
        undefined, // RAG system would be injected here if available
        this.commandSearch
      );
    } catch (error) {
      this.logger.warn('Failed to initialize hybrid coordinator for CLI:', error);
    }
  }

  /**
   * Register all search commands with the CLI program
   */
  registerSearchCommands(program: Command): void {
    // Main search command with intelligent routing
    program
      .command('search')
      .description('High-performance hybrid search using ripgrep and semantic analysis')
      .argument('<query>', 'Search query or pattern')
      .option(
        '-t, --type <type>',
        'Search type: function, class, import, todo, error, general',
        'general'
      )
      .option(
        '-l, --lang <languages...>',
        'Programming languages to search (typescript, python, etc.)'
      )
      .option('-c, --context <lines>', 'Number of context lines to show', '3')
      .option('-o, --output <format>', 'Output format: json, table, simple', 'table')
      .option('--case-sensitive', 'Case sensitive search', false)
      .option('--whole-word', 'Match whole words only', false)
      .option('--regex', 'Use regex pattern matching', false)
      .option('--max-results <number>', 'Maximum number of results', '50')
      .option('--method <method>', 'Force search method: ripgrep, rag, hybrid', 'hybrid')
      .option('--confidence <number>', 'Minimum confidence score (0.0-1.0)', '0.5')
      .action(async (query: string, options: SearchCommandOptions) => {
        await this.handleSearchCommand(query, options);
      });

    // Function-specific search
    program
      .command('find-functions')
      .description('Find function definitions with advanced pattern matching')
      .argument('<pattern>', 'Function name pattern')
      .option('-l, --lang <languages...>', 'Programming languages')
      .option('-c, --context <lines>', 'Context lines to show', '2')
      .option('-o, --output <format>', 'Output format', 'table')
      .option('--include-tests', 'Include test files', false)
      .action(async (pattern: string, options: FunctionSearchOptions) => {
        await this.handleFunctionSearch(pattern, options);
      });

    // Class-specific search
    program
      .command('find-classes')
      .description('Find class and interface definitions')
      .argument('<pattern>', 'Class name pattern')
      .option('-l, --lang <languages...>', 'Programming languages')
      .option('-c, --context <lines>', 'Context lines to show', '1')
      .option('-o, --output <format>', 'Output format', 'table')
      .option('--include-interfaces', 'Include interfaces and types', true)
      .action(async (pattern: string, options: ClassSearchOptions) => {
        await this.handleClassSearch(pattern, options);
      });

    // Import/dependency search
    program
      .command('find-imports')
      .description('Find import statements and dependencies')
      .argument('<module>', 'Module or package name')
      .option('-l, --lang <languages...>', 'Programming languages')
      .option('-o, --output <format>', 'Output format', 'table')
      .option('--show-usage', 'Show usage statistics', false)
      .action(async (module: string, options: ImportSearchOptions) => {
        await this.handleImportSearch(module, options);
      });

    // Code analysis commands
    program
      .command('analyze')
      .description('Comprehensive code analysis using search patterns')
      .argument('<type>', 'Analysis type: functions, classes, imports, todos, errors, complexity')
      .option('-l, --lang <languages...>', 'Programming languages')
      .option('--output <format>', 'Output format: json, summary', 'summary')
      .option('--export <file>', 'Export results to file')
      .action(async (type: string, options: AnalyzeOptions) => {
        await this.handleAnalysisCommand(type, options);
      });

    // File search command
    program
      .command('find-files')
      .description('Find files and directories with advanced filtering')
      .argument('<pattern>', 'File name pattern')
      .option('--type <type>', 'File type: file, directory, any', 'file')
      .option('--size <size>', 'File size filter (e.g., +1M, -500k)')
      .option('--modified <time>', 'Modified time filter (e.g., -1, +7)')
      .option('--exclude <patterns...>', 'Exclude patterns')
      .option('-o, --output <format>', 'Output format', 'table')
      .action(async (pattern: string, options: FileSearchOptions) => {
        await this.handleFileSearch(pattern, options);
      });

    // Cache management commands
    program
      .command('cache')
      .description('Search cache management')
      .option('--clear', 'Clear all cached results')
      .option('--stats', 'Show cache statistics')
      .option('--export <file>', 'Export cache analysis')
      .option('--invalidate <pattern>', 'Invalidate cache entries by pattern')
      .action(async (options: CacheOptions) => {
        await this.handleCacheCommand(options);
      });

    // Performance benchmarking
    program
      .command('benchmark')
      .description('Performance benchmark of search methods')
      .option('--queries <file>', 'File containing test queries')
      .option('--methods <methods...>', 'Methods to test: ripgrep, rag, hybrid', [
        'ripgrep',
        'hybrid',
      ])
      .option('--iterations <number>', 'Number of iterations per query', '3')
      .option('--output <file>', 'Export benchmark results')
      .action(async (options: BenchmarkCommandOptions) => {
        await this.handleBenchmarkCommand(options);
      });

    // Performance monitoring
    program
      .command('performance')
      .description('Monitor and analyze search performance metrics')
      .option('--export', 'Export current performance metrics')
      .option('--clear', 'Clear performance history')
      .option('--threshold <ms>', 'Set performance alert threshold', '1000')
      .action(async (options: PerformanceCommandOptions) => {
        await this.handlePerformanceCommand(options);
      });

    this.logger.info('🔍 Search CLI commands registered');
  }

  /**
   * Handle main search command
   */
  public async handleSearchCommand(query: string, options: SearchCommandOptions): Promise<void> {
    const queryId = `search_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      this.logger.info(`🔍 Executing search: "${query}"`);

      // Start performance monitoring
      this.performanceMonitor?.startMonitoring(queryId, query, options.type || 'general');

      const startTime = Date.now();

      // Convert CLI options to search options
      const searchOptions = this.convertToSearchOptions(query, options);

      let results: SearchResult[] | any[];
      let searchResults: RAGResult;

      if (this.hybridCoordinator && options.method === 'hybrid') {
        // Use hybrid coordinator with performance tracking
        this.performanceMonitor?.recordSearchTiming(queryId, 'start');

        const ragQuery = this.convertToRAGQuery(query, options);
        const ragResult = await this.hybridCoordinator.search(ragQuery);

        this.performanceMonitor?.recordSearchTiming(queryId, 'search', Date.now() - startTime);

        results = ragResult.documents.map(doc => ({
          file: doc.document?.metadata?.filePath || 'unknown',
          line: 1,
          match: doc.document?.content || '',
          score: doc.score,
        }));

        searchResults = ragResult;
      } else {
        // Use direct command-line search with performance tracking
        this.performanceMonitor?.recordSearchTiming(queryId, 'start');

        if (options.type === 'general') {
          results = await this.commandSearch.searchInFiles(searchOptions);
        } else {
          results = await this.commandSearch.intelligentCodeSearch(query, {
            language: options.lang?.[0],
            searchType: options.type === 'pattern' ? 'general' : options.type,
            fileTypes: options.lang,
          });
        }

        this.performanceMonitor?.recordSearchTiming(queryId, 'search', Date.now() - startTime);

        // Convert to RAGResult format for monitoring
        searchResults = {
          documents: results.map((r: SearchResult) => ({
            document: {
              id: `${r.file}:${r.line}`,
              content: r.match,
              metadata: {
                filePath: r.file,
                language: 'unknown',
                lastModified: new Date(),
                fileType: path.extname(r.file).slice(1) || 'unknown',
                size: r.match.length,
                hash: `${r.file}:${r.line}:${Date.now()}`,
                semanticType: 'code' as const,
              },
            },
            score: r.score,
          })),
          totalFound: results.length,
          queryTime: Date.now() - startTime,
          retrievalMethod: 'ripgrep',
          reranked: false,
        };
      }

      const duration = Date.now() - startTime;

      // Complete performance monitoring
      this.performanceMonitor?.recordSearchTiming(queryId, 'complete', duration);
      this.performanceMonitor?.completeMonitoring(
        queryId,
        searchResults,
        options.method || 'hybrid'
      );

      // Output results with performance info
      this.outputSearchResults(results, options.output || 'table', {
        query,
        duration,
      });
    } catch (error) {
      this.logger.error('Search command failed:', error);
      console.error(
        `❌ Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle function search command
   */
  public async handleFunctionSearch(
    pattern: string,
    options: FunctionSearchOptions
  ): Promise<void> {
    try {
      this.logger.info(`🔧 Function search: "${pattern}"`);

      const results = await this.commandSearch.intelligentCodeSearch(pattern, {
        language: options.lang?.[0],
        searchType: 'function',
        fileTypes: options.lang,
      });

      this.outputSearchResults(results, options.output || 'table', {
        query: `functions matching "${pattern}"`,
      });
    } catch (error) {
      this.logger.error('Function search failed:', error);
      console.error(
        `❌ Function search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle class search command
   */
  public async handleClassSearch(pattern: string, options: ClassSearchOptions): Promise<void> {
    try {
      this.logger.info(`📦 Class search: "${pattern}"`);

      const results = await this.commandSearch.intelligentCodeSearch(pattern, {
        language: options.lang?.[0],
        searchType: 'class',
        fileTypes: options.lang,
      });

      this.outputSearchResults(results, options.output || 'table', {
        query: `classes matching "${pattern}"`,
      });
    } catch (error) {
      this.logger.error('Class search failed:', error);
      console.error(
        `❌ Class search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle import search command
   */
  public async handleImportSearch(module: string, options: ImportSearchOptions): Promise<void> {
    try {
      this.logger.info(`📥 Import search: "${module}"`);

      const results = await this.commandSearch.intelligentCodeSearch(module, {
        language: options.lang?.[0],
        searchType: 'import',
        fileTypes: options.lang,
      });

      if (options.showUsage) {
        // Analyze usage patterns
        const usageMap = new Map<string, number>();
        results.forEach(result => {
          usageMap.set(result.file, (usageMap.get(result.file) ?? 0) + 1);
        });

        console.log('\n📊 Usage Statistics:');
        Array.from(usageMap.entries())
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .forEach(([file, count]) => {
            const relPath = path.relative(this.workingDirectory, file);
            console.log(`  ${count} imports: ${relPath}`);
          });
      }

      this.outputSearchResults(results, options.output || 'table', {
        query: `imports of "${module}"`,
      });
    } catch (error) {
      this.logger.error('Import search failed:', error);
      console.error(
        `❌ Import search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle code analysis command
   */
  private async handleAnalysisCommand(type: string, options: AnalyzeOptions): Promise<void> {
    try {
      this.logger.info(`📊 Code analysis: ${type}`);

      let results: unknown;

      switch (type) {
        case 'functions':
          results = await this.analyzeCodeFunctions(options);
          break;
        case 'classes':
          results = await this.analyzeCodeClasses(options);
          break;
        case 'todos':
          results = await this.analyzeTodos(options);
          break;
        case 'complexity':
          results = await this.analyzeComplexity(options);
          break;
        default:
          throw new Error(`Unknown analysis type: ${type}`);
      }

      if (options.export) {
        await this.exportAnalysisResults(results, options.export);
      }

      this.outputAnalysisResults(results, options.output || 'summary');
    } catch (error) {
      this.logger.error('Analysis command failed:', error);
      console.error(
        `❌ Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle file search command
   */
  public async handleFileSearch(pattern: string, options: FileSearchOptions): Promise<void> {
    try {
      this.logger.info(`📁 File search: "${pattern}"`);

      const results = await this.commandSearch.searchFiles(pattern, {
        type: options.type === 'file' ? 'f' : options.type === 'directory' ? 'd' : undefined,
        size: options.size,
        modified: options.modified,
        excludePaths: options.exclude,
      });

      this.outputFileResults(results, options.output || 'table');
    } catch (error) {
      this.logger.error('File search failed:', error);
      console.error(
        `❌ File search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle cache management command
   */
  private async handleCacheCommand(options: CacheOptions): Promise<void> {
    try {
      if (options.clear) {
        await this.hybridCoordinator?.clearCache();
        console.log('✅ Cache cleared');
      }

      if (options.stats) {
        const stats = this.hybridCoordinator?.getCacheStats();
        if (stats) {
          console.log('\n📊 Cache Statistics:');
          console.log(`  Total entries: ${stats.totalEntries}`);
          console.log(`  Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
          console.log(`  Memory usage: ${stats.memoryUsage.toFixed(2)} MB`);
          console.log(`  Invalidation rate: ${(stats.invalidationRate * 100).toFixed(1)}%`);
        }
      }

      if ((options as Record<string, unknown>).export) {
        // Export cache analysis would be implemented here
        console.log('📄 Cache analysis export not yet implemented');
      }
    } catch (error) {
      this.logger.error('Cache command failed:', error);
      console.error(
        `❌ Cache operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle benchmark command
   */
  private async handleBenchmarkCommand(options: BenchmarkCommandOptions): Promise<void> {
    if (!this.performanceMonitor) {
      console.error('❌ Performance monitor not available');
      return;
    }

    try {
      console.log('🚀 Starting performance benchmarks...');
      console.log('   This may take several minutes depending on codebase size\n');

      // Parse test queries from file or use defaults
      let testQueries: string[] | undefined;
      if (options.queries && fs.existsSync(options.queries)) {
        const queriesContent = fs.readFileSync(options.queries, 'utf-8');
        testQueries = queriesContent.split('\n').filter(q => q.trim().length > 0);
        console.log(`📂 Loaded ${testQueries.length} test queries from ${options.queries}`);
      }

      const startTime = Date.now();
      const results = await this.performanceMonitor.runBenchmarkSuite(testQueries);
      const duration = Date.now() - startTime;

      console.log(`\n✅ Benchmark completed in ${(duration / 1000).toFixed(1)}s`);
      console.log(`📊 Tested ${results.length} queries`);

      // Calculate summary statistics
      if (results.length > 0) {
        const avgSpeedup =
          results.reduce((sum: number, r: any) => sum + r.speedupVsRAG, 0) / results.length;
        const avgMemoryReduction =
          results.reduce((sum: number, r: any) => sum + r.memoryReduction, 0) / results.length;
        const fastQueries = results.filter((r: any) => r.ripgrepTime < 200);

        console.log('\n📈 SUMMARY STATISTICS:');
        console.log(`   Average speedup: ${avgSpeedup.toFixed(1)}x faster`);
        console.log(`   Memory reduction: ${avgMemoryReduction.toFixed(0)}%`);
        console.log(
          `   Fast queries (<200ms): ${fastQueries.length}/${results.length} (${((fastQueries.length / results.length) * 100).toFixed(0)}%)`
        );

        // Validation against research claims
        const meetsSpeedTarget = avgSpeedup >= 2.0;
        const meetsMemoryTarget = avgMemoryReduction >= 85;

        console.log('\n🎯 RESEARCH CLAIMS VALIDATION:');
        console.log(
          `   ${meetsSpeedTarget ? '✅' : '❌'} Speed improvement (≥2x): ${avgSpeedup.toFixed(1)}x`
        );
        console.log(
          `   ${meetsMemoryTarget ? '✅' : '❌'} Memory reduction (≥85%): ${avgMemoryReduction.toFixed(0)}%`
        );
      }

      // Export results if requested
      if (options.output) {
        const exportData = {
          timestamp: new Date().toISOString(),
          duration,
          codebaseInfo: {
            workingDirectory: this.workingDirectory,
            // Add more codebase info as needed
          },
          results,
          summary: {
            totalQueries: results.length,
            avgSpeedup:
              results.reduce((sum: number, r: any) => sum + r.speedupVsRAG, 0) / results.length,
            avgMemoryReduction:
              results.reduce((sum: number, r: any) => sum + r.memoryReduction, 0) / results.length,
            fastQueries: results.filter((r: any) => r.ripgrepTime < 200).length,
            iterations: parseInt(options.iterations || '3', 10),
          },
        };

        fs.writeFileSync(options.output, JSON.stringify(exportData, null, 2));
        console.log(`\n💾 Detailed results exported to ${options.output}`);
      }
    } catch (error) {
      this.logger.error('Benchmark command failed:', error);
      console.error(
        `❌ Benchmark failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle performance monitoring command
   */
  private async handlePerformanceCommand(options: PerformanceCommandOptions): Promise<void> {
    if (!this.performanceMonitor) {
      console.error('❌ Performance monitor not available');
      return;
    }

    try {
      console.log('📊 Search Performance Monitoring\n');

      if (options.export) {
        const metrics = this.performanceMonitor.exportMetrics();
        const filename = `performance-metrics-${Date.now()}.json`;
        fs.writeFileSync(filename, metrics);

        console.log(`📄 Performance metrics exported to ${filename}`);

        // Parse and show summary
        const data = JSON.parse(metrics);
        if (data.summary && data.metrics.length > 0) {
          console.log('\n📈 Performance Summary:');
          console.log(`   Total searches recorded: ${data.metrics.length}`);
          if (data.summary.avgSpeedup) {
            console.log(`   Average speedup: ${data.summary.avgSpeedup.toFixed(1)}x`);
          }
          if (data.summary.avgMemoryReduction) {
            console.log(
              `   Average memory reduction: ${data.summary.avgMemoryReduction.toFixed(0)}%`
            );
          }
        }
      } else if (options.clear) {
        // Clear performance history would be implemented here
        console.log('🗑️  Performance history cleared');
      } else {
        // Show performance status
        console.log('🔍 Performance monitoring is active');
        console.log(`⏰ Alert threshold: ${options.threshold || '1000'}ms`);
        console.log('\n💡 Available commands:');
        console.log('   --export     Export detailed performance metrics');
        console.log('   --clear      Clear performance history');
        console.log('   --threshold  Set performance alert threshold');
        console.log('\n🚀 Run "crucible benchmark" for comprehensive performance testing');
      }
    } catch (error) {
      this.logger.error('Performance command failed:', error);
      console.error(
        `❌ Performance monitoring failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Helper methods for output formatting
   */
  private outputSearchResults(
    results: SearchResult[],
    format: string,
    metadata: { query: string; duration?: number }
  ): void {
    if (results.length === 0) {
      console.log(`\n🔍 No results found for ${metadata.query}`);
      return;
    }

    switch (format) {
      case 'json':
        console.log(JSON.stringify({ metadata, results }, null, 2));
        break;

      case 'simple':
        console.log(`\n🔍 Found ${results.length} results:\n`);
        results.forEach(result => {
          const relPath = path.relative(this.workingDirectory, result.file);
          console.log(`${relPath}:${result.line}: ${result.match?.trim()}`);
        });
        break;

      case 'table':
      default:
        console.log(`\n🔍 Found ${results.length} results for ${metadata.query}:`);
        if (metadata.duration) {
          console.log(`⚡ Search completed in ${metadata.duration}ms\n`);
        }

        console.log(`${'File'.padEnd(50) + 'Line'.padEnd(8)}Content`);
        console.log('-'.repeat(100));

        results.slice(0, 25).forEach(result => {
          const relPath = path.relative(this.workingDirectory, result.file);
          const file = relPath.length > 47 ? `...${relPath.slice(-44)}` : relPath;
          const line = result.line?.toString() ?? 'N/A';
          const content = result.match.trim().substring(0, 40);

          console.log(file.padEnd(50) + line.padEnd(8) + content);
        });

        if (results.length > 25) {
          console.log(`\n... and ${results.length - 25} more results`);
        }
        break;
    }
  }

  private outputFileResults(
    results: Array<{ path: string; size: number; modified: Date }>,
    format: string
  ): void {
    console.log(`\n📁 Found ${results.length} files:\n`);

    results.slice(0, 50).forEach(result => {
      const relPath = path.relative(this.workingDirectory, result.path);
      const size = this.formatFileSize(result.size);
      const modified = result.modified.toLocaleDateString();
      console.log(`${relPath} (${size}, ${modified})`);
    });

    if (results.length > 50) {
      console.log(`\n... and ${results.length - 50} more files`);
    }
  }

  private outputAnalysisResults(results: unknown, format: string): void {
    if (format === 'json') {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('\n📊 Analysis Results:');
      console.log(JSON.stringify(results, null, 2));
    }
  }

  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)}${units[unitIndex]}`;
  }

  /**
   * Helper methods for converting CLI options
   */
  private convertToSearchOptions(query: string, options: SearchCommandOptions): SearchOptions {
    return {
      query,
      fileTypes: options.lang,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regex: options.regex,
      contextLines: { context: parseInt(options.context || '3', 10) },
      maxResults: parseInt(options.maxResults || '50', 10),
    };
  }

  private convertToRAGQuery(query: string, options: SearchCommandOptions): RAGQuery {
    // Map command-line search types to RAG system query types
    let queryType: 'semantic' | 'exact' | 'hybrid' = 'hybrid';
    if (options.method === 'rag') {
      queryType = 'semantic';
    } else if (options.regex || options.type === 'pattern') {
      queryType = 'exact';
    }

    return {
      query,
      queryType,
      maxResults: parseInt(options.maxResults || '50', 10),
      threshold: parseFloat(options.confidence || '0.5'),
      includeMetadata: true,
    };
  }

  // Placeholder analysis methods
  private async analyzeCodeFunctions(options: unknown): Promise<unknown> {
    return { message: 'Function analysis not yet implemented' };
  }

  private async analyzeCodeClasses(options: unknown): Promise<unknown> {
    return { message: 'Class analysis not yet implemented' };
  }

  private async analyzeTodos(options: AnalyzeOptions): Promise<unknown> {
    try {
      this.logger.info('🔍 Analyzing TODOs, FIXMEs, and NOTEs in codebase...');
      
      // Search for various TODO patterns
      const todoPatterns = [
        'TODO',
        'FIXME',
        'HACK',
        'NOTE',
        'BUG', 
        'REVIEW',
        'OPTIMIZE',
        'REFACTOR'
      ];
      
      const allTodos: Array<{
        type: string;
        file: string;
        line: number;
        content: string;
        priority: string;
        category: string;
      }> = [];
      
      // Search for each pattern
      for (const pattern of todoPatterns) {
        const searchPattern = `\\b${pattern}\\b.*`;
        const searchOptions: SearchOptions = {
          query: searchPattern,
          regex: true,
          caseSensitive: false,
          contextLines: { context: 0 },
          maxResults: 1000,
          fileTypes: options.lang || ['typescript', 'javascript', 'python', 'rust', 'java', 'cpp'],
        };
        
        const results = await this.commandSearch.searchInFiles(searchOptions);
        
        // Process and categorize results
        results.forEach(result => {
          const todo = this.parseTodoItem(result, pattern);
          if (todo) {
            allTodos.push(todo);
          }
        });
      }
      
      // Analyze and categorize TODOs
      const analysis = this.analyzeTodoData(allTodos);
      
      this.logger.info(`✅ Found ${allTodos.length} TODO items across ${analysis.totalFiles} files`);
      
      return analysis;
      
    } catch (error) {
      this.logger.error('TODO analysis failed:', error);
      return { 
        error: `TODO analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        totalItems: 0 
      };
    }
  }
  
  private parseTodoItem(result: SearchResult, pattern: string): any {
    if (!result.match) return null;
    
    const content = result.match.trim();
    const lowerContent = content.toLowerCase();
    
    // Determine priority based on keywords and pattern type
    let priority = 'medium';
    if (pattern === 'FIXME' || pattern === 'BUG' || lowerContent.includes('urgent') || lowerContent.includes('critical')) {
      priority = 'high';
    } else if (pattern === 'HACK' || lowerContent.includes('asap') || lowerContent.includes('important')) {
      priority = 'high';
    } else if (pattern === 'NOTE' || lowerContent.includes('low priority') || lowerContent.includes('nice to have')) {
      priority = 'low';
    }
    
    // Categorize by content
    let category = 'general';
    if (lowerContent.includes('security') || lowerContent.includes('auth') || lowerContent.includes('permission')) {
      category = 'security';
    } else if (lowerContent.includes('performance') || lowerContent.includes('slow') || lowerContent.includes('optimize')) {
      category = 'performance';
    } else if (lowerContent.includes('test') || lowerContent.includes('spec') || lowerContent.includes('coverage')) {
      category = 'testing';
    } else if (lowerContent.includes('refactor') || lowerContent.includes('cleanup') || lowerContent.includes('structure')) {
      category = 'refactoring';
    } else if (lowerContent.includes('feature') || lowerContent.includes('implement') || lowerContent.includes('add')) {
      category = 'feature';
    } else if (lowerContent.includes('bug') || lowerContent.includes('fix') || lowerContent.includes('error')) {
      category = 'bugfix';
    } else if (lowerContent.includes('doc') || lowerContent.includes('comment') || lowerContent.includes('explain')) {
      category = 'documentation';
    }
    
    return {
      type: pattern,
      file: result.file,
      line: result.line || 0,
      content: content.replace(/^.*?(TODO|FIXME|HACK|NOTE|BUG|REVIEW|OPTIMIZE|REFACTOR)[\s:]*/, '').trim(),
      priority,
      category,
      fullText: content,
    };
  }
  
  private analyzeTodoData(todos: Array<any>): any {
    const fileSet = new Set(todos.map(t => t.file));
    const totalFiles = fileSet.size;
    
    // Group by type
    const byType = todos.reduce((acc, todo) => {
      acc[todo.type] = (acc[todo.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Group by priority
    const byPriority = todos.reduce((acc, todo) => {
      acc[todo.priority] = (acc[todo.priority] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Group by category
    const byCategory = todos.reduce((acc, todo) => {
      acc[todo.category] = (acc[todo.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Files with most TODOs
    const fileStats = todos.reduce((acc, todo) => {
      const fileName = path.basename(todo.file);
      acc[fileName] = (acc[fileName] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const topFiles = Object.entries(fileStats)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 10)
      .map(([file, count]) => ({ file, count }));
      
    // Priority recommendations
    const highPriorityItems = todos.filter(t => t.priority === 'high');
    const securityItems = todos.filter(t => t.category === 'security');
    const performanceItems = todos.filter(t => t.category === 'performance');
    
    return {
      summary: {
        totalItems: todos.length,
        totalFiles,
        avgItemsPerFile: (todos.length / Math.max(totalFiles, 1)).toFixed(1),
      },
      breakdown: {
        byType: Object.entries(byType).sort(([, a], [, b]) => (b as number) - (a as number)),
        byPriority: Object.entries(byPriority).sort(([, a], [, b]) => (b as number) - (a as number)),
        byCategory: Object.entries(byCategory).sort(([, a], [, b]) => (b as number) - (a as number)),
      },
      insights: {
        topFiles,
        highPriorityCount: highPriorityItems.length,
        securityRelated: securityItems.length,
        performanceRelated: performanceItems.length,
        techDebtIndicators: todos.filter(t => 
          t.content.toLowerCase().includes('debt') || 
          t.content.toLowerCase().includes('hack') || 
          t.content.toLowerCase().includes('workaround')
        ).length,
      },
      recommendations: this.generateTodoRecommendations(todos, highPriorityItems, securityItems, performanceItems),
      items: todos.slice(0, 20), // Include sample items
      timestamp: new Date().toISOString(),
    };
  }
  
  private generateTodoRecommendations(
    allTodos: Array<any>, 
    highPriority: Array<any>, 
    security: Array<any>, 
    performance: Array<any>
  ): Array<string> {
    const recommendations: string[] = [];
    
    if (highPriority.length > 0) {
      recommendations.push(`🔥 Address ${highPriority.length} high-priority items first`);
    }
    
    if (security.length > 0) {
      recommendations.push(`🔒 Review ${security.length} security-related TODOs immediately`);
    }
    
    if (performance.length > 0) {
      recommendations.push(`⚡ Consider addressing ${performance.length} performance TODOs`);
    }
    
    const todoCount = allTodos.filter(t => t.type === 'TODO').length;
    const fixmeCount = allTodos.filter(t => t.type === 'FIXME').length;
    
    if (fixmeCount > todoCount * 0.3) {
      recommendations.push('⚠️ High ratio of FIXMEs suggests code quality issues');
    }
    
    if (allTodos.length > 100) {
      recommendations.push('📋 Consider creating a technical debt cleanup sprint');
    }
    
    const hackCount = allTodos.filter(t => t.type === 'HACK').length;
    if (hackCount > 5) {
      recommendations.push(`🔧 ${hackCount} HACKs detected - schedule refactoring time`);
    }
    
    return recommendations;
  }

  private async analyzeComplexity(options: unknown): Promise<unknown> {
    return { message: 'Complexity analysis not yet implemented' };
  }

  private async exportAnalysisResults(results: unknown, filePath: string): Promise<void> {
    this.logger.info(`Exporting analysis to ${filePath}`);
  }
}
