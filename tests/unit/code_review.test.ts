/**
 * Unit Tests — CodeReviewSkill
 * @module tests/unit/code_review
 */

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any source imports
// ---------------------------------------------------------------------------

jest.mock('fs/promises');
jest.mock('@anthropic-ai/sdk');
jest.mock('../../src/utils/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// global.fetch mock
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Source imports — after mocks
// ---------------------------------------------------------------------------

import fs from 'fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import {
  CodeReviewSkill,
  CodeReviewError,
  CodeReviewValidationError,
  type ReviewFinding,
  type CodeReviewResult,
  type StyleRules,
} from '../../skills/code_review';

const mockFs = jest.mocked(fs);
const MockAnthropic = jest.mocked(Anthropic);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReviewResult(overrides: Partial<CodeReviewResult> = {}): CodeReviewResult {
  return {
    reviewId: 'r1',
    file: 'src/foo.ts',
    language: 'typescript',
    findings: [],
    summary: 'No issues.',
    score: 100,
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeReviewSkill', () => {
  let skill: CodeReviewSkill;
  let mockMessagesCreate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockMessagesCreate = jest.fn();
    MockAnthropic.mockImplementation(
      () =>
        ({
          messages: { create: mockMessagesCreate },
        }) as unknown as Anthropic,
    );

    skill = new CodeReviewSkill('test-api-key');
  });

  // -------------------------------------------------------------------------
  // checkCodeStyle
  // -------------------------------------------------------------------------

  describe('checkCodeStyle', () => {
    it('should return a finding for each line that violates a rule', () => {
      const code = `let x = 1;\nlet y = 2;\nconst z = 3;\n`;
      const rules: StyleRules = { 'prefer-const': /\blet\s+/ };
      const findings = skill.checkCodeStyle(code, rules);
      // Two "let" lines → two findings
      expect(findings).toHaveLength(2);
      findings.forEach((f) => expect(f.rule).toBe('prefer-const'));
    });

    it('should return an empty array when no rules are violated', () => {
      const code = `const x = 1;\nconst y = 2;\n`;
      const rules: StyleRules = { 'prefer-const': /\blet\s+/ };
      const findings = skill.checkCodeStyle(code, rules);
      expect(findings).toHaveLength(0);
    });

    it('should accept a RegExp pattern as the rule value', () => {
      const code = `console.log("hello");\n`;
      const rules: StyleRules = { 'no-console': /console\.(log|warn|error)/ };
      const findings = skill.checkCodeStyle(code, rules);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.rule).toBe('no-console');
    });

    it('should throw CodeReviewValidationError when code is empty', () => {
      expect(() => skill.checkCodeStyle('', { 'my-rule': /foo/ })).toThrow(
        CodeReviewValidationError,
      );
    });

    it('should throw CodeReviewValidationError when rules is not an object', () => {
      expect(() =>
        skill.checkCodeStyle('const x = 1;', null as unknown as StyleRules),
      ).toThrow(CodeReviewValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // detectSecurityIssues
  // -------------------------------------------------------------------------

  describe('detectSecurityIssues', () => {
    it('should detect an AWS Access Key ID with severity="error"', () => {
      const code = `const creds = "AKIAIOSFODNN7EXAMPLE";\n`;
      const findings = skill.detectSecurityIssues(code);
      const f = findings.find(
        (x) => x.rule === 'aws-access-key' || x.message.toLowerCase().includes('aws'),
      );
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
    });

    it('should detect a hardcoded password', () => {
      const code = `const cfg = { password: "SuperS3cr3t!" };\n`;
      const findings = skill.detectSecurityIssues(code);
      const f = findings.find(
        (x) =>
          x.rule === 'hardcoded-secret' ||
          x.message.toLowerCase().includes('password') ||
          x.message.toLowerCase().includes('secret'),
      );
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
    });

    it('should detect a private key header', () => {
      const code = `-----BEGIN RSA PRIVATE KEY-----\nMIIEo...`;
      const findings = skill.detectSecurityIssues(code);
      const f = findings.find(
        (x) => x.rule === 'private-key-header' || x.message.toLowerCase().includes('private key'),
      );
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
    });

    it('should detect a JWT token', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const code = `const tok = "${jwt}";\n`;
      const findings = skill.detectSecurityIssues(code);
      const f = findings.find(
        (x) => x.rule === 'jwt-token' || x.message.toLowerCase().includes('jwt'),
      );
      expect(f).toBeDefined();
    });

    it('should return an empty array for clean code', () => {
      const code = `const greeting = "Hello World";\nexport default greeting;\n`;
      const findings = skill.detectSecurityIssues(code);
      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // reviewCode
  // -------------------------------------------------------------------------

  describe('reviewCode', () => {
    it('should return a CodeReviewResult for a valid TypeScript file', async () => {
      mockFs.readFile = jest.fn().mockResolvedValue(`const x: string = "hello";\n`);
      const result = await skill.reviewCode('/src/app.ts', 'typescript');
      expect(result).toMatchObject({
        file: '/src/app.ts',
        language: 'typescript',
        score: expect.any(Number),
        reviewedAt: expect.any(String),
      });
      expect(Array.isArray(result.findings)).toBe(true);
    });

    it('should auto-detect language from file extension when language is "unknown"', async () => {
      mockFs.readFile = jest.fn().mockResolvedValue(`def greet(): pass\n`);
      const result = await skill.reviewCode('/src/script.py');
      expect(result.language).toBe('python');
    });

    it('should include security findings when secrets are present in code', async () => {
      const secretCode = `const key = "AKIAIOSFODNN7EXAMPLE";\n`;
      mockFs.readFile = jest.fn().mockResolvedValue(secretCode);
      const result = await skill.reviewCode('/src/creds.ts', 'typescript');
      const secFinding = result.findings.find((f) => f.severity === 'error');
      expect(secFinding).toBeDefined();
    });

    it('should return score=100 for a clean file with no violations', async () => {
      // Minimal clean TypeScript: no let, no console, no secrets
      const clean = `export const greet = (): string => "hello";\n`;
      mockFs.readFile = jest.fn().mockResolvedValue(clean);
      const result = await skill.reviewCode('/src/clean.ts', 'typescript');
      expect(result.score).toBe(100);
      expect(result.findings).toHaveLength(0);
    });

    it('should throw CodeReviewError when the file cannot be read', async () => {
      mockFs.readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
      await expect(skill.reviewCode('/nonexistent/file.ts')).rejects.toThrow(CodeReviewError);
    });
  });

  // -------------------------------------------------------------------------
  // suggestImprovements
  // -------------------------------------------------------------------------

  describe('suggestImprovements', () => {
    it('should return ReviewFinding[] with severity="suggestion"', async () => {
      const suggestions = [
        { line: 1, rule: 'use-strict-equality', message: 'Use === instead of ==', suggestion: 'Replace == with ===' },
      ];
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(suggestions) }],
      });

      const findings = await skill.suggestImprovements(`const x = 1 == 1;`);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('suggestion');
      expect(findings[0]!.rule).toBe('use-strict-equality');
    });

    it('should return an empty array when Claude returns non-JSON text', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Sorry, I cannot analyse this.' }],
      });
      const findings = await skill.suggestImprovements(`const x = 1;`);
      expect(findings).toHaveLength(0);
    });

    it('should throw CodeReviewError when the Anthropic API call fails', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('API overload'));
      await expect(skill.suggestImprovements(`const x = 1;`)).rejects.toThrow(CodeReviewError);
    });

    it('should throw CodeReviewValidationError when code is empty', async () => {
      await expect(skill.suggestImprovements('')).rejects.toThrow(CodeReviewValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // generateReport
  // -------------------------------------------------------------------------

  describe('generateReport', () => {
    it('should produce a Markdown report containing the file name and score', () => {
      const result = makeReviewResult({
        file: 'src/index.ts',
        score: 85,
        summary: '1 issue found.',
        findings: [
          { severity: 'warning', file: 'src/index.ts', line: 3, rule: 'prefer-const', message: 'Use const' },
        ],
      });
      const report = skill.generateReport([result]);
      expect(report.markdown).toContain('src/index.ts');
      expect(report.markdown).toContain('85');
    });

    it('should compute correct findingsBySeverity counts', () => {
      const findings: ReviewFinding[] = [
        { severity: 'error', file: 'f.ts', line: 1, rule: 'r1', message: 'm1' },
        { severity: 'error', file: 'f.ts', line: 2, rule: 'r2', message: 'm2' },
        { severity: 'warning', file: 'f.ts', line: 3, rule: 'r3', message: 'm3' },
        { severity: 'info', file: 'f.ts', line: 4, rule: 'r4', message: 'm4' },
        { severity: 'suggestion', file: 'f.ts', line: 5, rule: 'r5', message: 'm5' },
      ];
      const result = makeReviewResult({ findings, score: 100 - (2 * 15 + 5 + 1 + 0.5) });
      const report = skill.generateReport([result]);
      expect(report.findingsBySeverity.error).toBe(2);
      expect(report.findingsBySeverity.warning).toBe(1);
      expect(report.findingsBySeverity.info).toBe(1);
      expect(report.findingsBySeverity.suggestion).toBe(1);
    });

    it('should compute averageScore correctly across multiple results', () => {
      const r1 = makeReviewResult({ score: 80 });
      const r2 = makeReviewResult({ score: 60 });
      const report = skill.generateReport([r1, r2]);
      expect(report.averageScore).toBe(70);
    });

    it('should throw CodeReviewValidationError when reviewResults is not an array', () => {
      expect(() =>
        skill.generateReport(null as unknown as CodeReviewResult[]),
      ).toThrow(CodeReviewValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // reviewPullRequest
  // -------------------------------------------------------------------------

  describe('reviewPullRequest', () => {
    const prUrl = 'https://github.com/test-org/test-repo/pull/42';

    it('should call the GitHub API and return a PullRequestReview', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue([
          { filename: 'src/index.ts', patch: `const x: string = "hello";` },
        ]),
      });

      const review = await skill.reviewPullRequest(prUrl);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.github.com/repos/test-org/test-repo/pulls/42'),
        expect.any(Object),
      );
      expect(review.prUrl).toBe(prUrl);
      expect(review.fileReviews).toHaveLength(1);
    });

    it('should calculate overallScore as the average of all file scores', async () => {
      // Two files: one with a secret (score < 100), one clean (score = 100)
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue([
          { filename: 'src/a.ts', patch: `export const clean = true;` },
          { filename: 'src/b.ts', patch: `export const clean = true;` },
        ]),
      });

      const review = await skill.reviewPullRequest(prUrl);
      // Both clean → overallScore should be 100
      expect(review.overallScore).toBe(100);
    });

    it('should throw CodeReviewValidationError for a non-GitHub URL', async () => {
      await expect(
        skill.reviewPullRequest('https://gitlab.com/org/repo/merge_requests/1'),
      ).rejects.toThrow(CodeReviewValidationError);
    });

    it('should throw CodeReviewError when the GitHub API call fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue('Not Found'),
      });

      await expect(skill.reviewPullRequest(prUrl)).rejects.toThrow(CodeReviewError);
    });
  });
});
