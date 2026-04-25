/**
 * Unit Tests — SecurityScanningSkill
 * @module tests/unit/security_scanning
 */

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any source imports
// ---------------------------------------------------------------------------

jest.mock('fs/promises');
jest.mock('../../src/utils/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Source imports — after mocks
// ---------------------------------------------------------------------------

import fs from 'fs/promises';
import {
  SecurityScanningSkill,
  SecurityScanValidationError,
  SecurityScanError,
  type SecurityFinding,
} from '../../skills/security_scanning';

const mockFs = jest.mocked(fs);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SecurityScanningSkill', () => {
  let scanner: SecurityScanningSkill;

  beforeEach(() => {
    jest.clearAllMocks();
    scanner = new SecurityScanningSkill();
  });

  // -------------------------------------------------------------------------
  // scanSecrets (synchronous)
  // -------------------------------------------------------------------------

  describe('scanSecrets', () => {
    it('should detect an AWS Access Key ID as CRITICAL', () => {
      const code = `const key = "AKIAIOSFODNN7EXAMPLE";`;
      const result = scanner.scanSecrets(code, 'test.ts');
      expect(result.findings.length).toBeGreaterThan(0);
      const finding = result.findings.find((f) => f.severity === 'CRITICAL');
      expect(finding).toBeDefined();
      expect(finding!.title).toMatch(/AWS Access Key/i);
    });

    it('should detect a hardcoded password as CRITICAL', () => {
      const code = `const cfg = { password: "S3cr3t!Pass123" };`;
      const result = scanner.scanSecrets(code, 'config.ts');
      const finding = result.findings.find((f) =>
        f.title.toLowerCase().includes('password') ||
        f.description.toLowerCase().includes('password'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('CRITICAL');
    });

    it('should detect a private key header as CRITICAL', () => {
      const code = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ...`;
      const result = scanner.scanSecrets(code, 'keys.pem');
      const finding = result.findings.find((f) =>
        f.title.toLowerCase().includes('private key'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('CRITICAL');
    });

    it('should detect a hardcoded JWT token', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const code = `const token = "${jwt}";`;
      const result = scanner.scanSecrets(code, 'auth.ts');
      const finding = result.findings.find((f) => f.title.toLowerCase().includes('jwt'));
      expect(finding).toBeDefined();
    });

    it('should return zero findings for clean code', () => {
      const code = `const greeting = "Hello, world!";`;
      const result = scanner.scanSecrets(code, 'greet.ts');
      expect(result.findings).toHaveLength(0);
    });

    it('should include the correct 1-based line number in findings', () => {
      // AWS key is on line 3
      const code = `// header\n// second line\nconst k = "AKIAIOSFODNN7EXAMPLE";\n`;
      const result = scanner.scanSecrets(code, 'lines.ts');
      const finding = result.findings.find((f) => f.title.match(/AWS Access Key/i));
      expect(finding).toBeDefined();
      expect(finding!.line).toBe(3);
      // id should encode line: e.g. "SEC001-L3"
      expect(finding!.id).toMatch(/L3$/);
    });
  });

  // -------------------------------------------------------------------------
  // scanDependencies
  // -------------------------------------------------------------------------

  describe('scanDependencies', () => {
    it('should detect a known vulnerable package (lodash < 4.17.21) and return a HIGH finding', async () => {
      const pkg = JSON.stringify({
        dependencies: { lodash: '4.17.4' },
      });
      mockFs.readFile = jest.fn().mockResolvedValue(pkg);
      const result = await scanner.scanDependencies('/fake/package.json');
      expect(result.findings.length).toBeGreaterThan(0);
      const f = result.findings.find((x) => x.title.toLowerCase().includes('lodash'));
      expect(f).toBeDefined();
      expect(['HIGH', 'CRITICAL']).toContain(f!.severity);
    });

    it('should return empty findings for a clean package.json', async () => {
      const pkg = JSON.stringify({
        dependencies: { lodash: '4.17.21', axios: '1.6.0' },
      });
      mockFs.readFile = jest.fn().mockResolvedValue(pkg);
      const result = await scanner.scanDependencies('/fake/package.json');
      expect(result.findings).toHaveLength(0);
    });

    it('should set autoFixable=true for all dependency findings', async () => {
      const pkg = JSON.stringify({
        dependencies: { minimist: '1.2.5' },
      });
      mockFs.readFile = jest.fn().mockResolvedValue(pkg);
      const result = await scanner.scanDependencies('/fake/package.json');
      expect(result.findings.length).toBeGreaterThan(0);
      result.findings.forEach((f) => expect(f.autoFixable).toBe(true));
    });

    it('should throw SecurityScanError when the file cannot be read', async () => {
      mockFs.readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
      await expect(scanner.scanDependencies('/nonexistent/package.json')).rejects.toThrow(
        SecurityScanError,
      );
    });

    it('should throw SecurityScanValidationError when packageJsonPath is empty', async () => {
      await expect(scanner.scanDependencies('')).rejects.toThrow(SecurityScanValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // scanDockerfile
  // -------------------------------------------------------------------------

  describe('scanDockerfile', () => {
    it("should flag 'latest' base image tag as HIGH", async () => {
      const content = 'FROM node:latest\nRUN npm install\n';
      mockFs.readFile = jest.fn().mockResolvedValue(content);
      const result = await scanner.scanDockerfile('/fake/Dockerfile');
      const finding = result.findings.find((f) => f.title.toLowerCase().includes('latest'));
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('HIGH');
    });

    it('should flag a Dockerfile with no USER instruction as MEDIUM', async () => {
      // No USER line at all
      const content = 'FROM node:20\nRUN npm install\nCMD ["node", "index.js"]\n';
      mockFs.readFile = jest.fn().mockResolvedValue(content);
      const result = await scanner.scanDockerfile('/fake/Dockerfile');
      const finding = result.findings.find(
        (f) => f.severity === 'MEDIUM' || f.title.toLowerCase().includes('user'),
      );
      expect(finding).toBeDefined();
    });

    it('should flag an ENV instruction containing a password value as CRITICAL', async () => {
      const content = 'FROM node:20\nENV DB_password=SuperSecret123\nUSER nonroot\n';
      mockFs.readFile = jest.fn().mockResolvedValue(content);
      const result = await scanner.scanDockerfile('/fake/Dockerfile');
      const finding = result.findings.find((f) => f.severity === 'CRITICAL');
      expect(finding).toBeDefined();
      expect(finding!.title).toMatch(/sensitive value|ENV/i);
    });

    it('should provide an autoFix for apt-get install without --no-install-recommends', async () => {
      const content =
        'FROM debian:12\nRUN apt-get install curl\nUSER nonroot\n';
      mockFs.readFile = jest.fn().mockResolvedValue(content);
      const result = await scanner.scanDockerfile('/fake/Dockerfile');
      const finding = result.findings.find((f) => f.autoFixable);
      expect(finding).toBeDefined();
      expect(finding!.autoFix).toBeDefined();
      expect(finding!.autoFix!.newContent).toContain('--no-install-recommends');
    });

    it('should throw SecurityScanError when the Dockerfile cannot be read', async () => {
      mockFs.readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
      await expect(scanner.scanDockerfile('/missing/Dockerfile')).rejects.toThrow(
        SecurityScanError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // scanKubernetesManifests
  // -------------------------------------------------------------------------

  describe('scanKubernetesManifests', () => {
    it('should flag missing runAsNonRoot as HIGH', async () => {
      const manifest = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.25
          resources:
            limits:
              cpu: "500m"
              memory: "256Mi"
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
`;
      mockFs.readdir = jest.fn().mockResolvedValue(['deployment.yaml']);
      mockFs.readFile = jest.fn().mockResolvedValue(manifest);
      const result = await scanner.scanKubernetesManifests('/fake/k8s');
      const finding = result.findings.find(
        (f) => f.id.startsWith('K8S001') || f.title.toLowerCase().includes('nonroot'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('HIGH');
    });

    it('should flag hostPID: true as CRITICAL', async () => {
      const manifest = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      hostPID: true
      containers:
        - name: app
          image: nginx:1.25
`;
      mockFs.readdir = jest.fn().mockResolvedValue(['deployment.yaml']);
      mockFs.readFile = jest.fn().mockResolvedValue(manifest);
      const result = await scanner.scanKubernetesManifests('/fake/k8s');
      const finding = result.findings.find(
        (f) => f.id.startsWith('K8S006') || f.title.toLowerCase().includes('hostpid'),
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('CRITICAL');
    });

    it('should scan all .yaml and .yml files in the directory', async () => {
      const yamlContent = `
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      image: nginx:1.25
      securityContext:
        runAsNonRoot: true
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
      resources:
        limits:
          cpu: "100m"
          memory: "128Mi"
`;
      mockFs.readdir = jest.fn().mockResolvedValue([
        'deploy.yaml',
        'service.yml',
        'readme.txt', // should be ignored
      ]);
      mockFs.readFile = jest.fn().mockResolvedValue(yamlContent);
      const result = await scanner.scanKubernetesManifests('/fake/k8s');
      expect(result.filesScanned).toHaveLength(2);
      expect(result.filesScanned.some((f) => f.endsWith('deploy.yaml'))).toBe(true);
      expect(result.filesScanned.some((f) => f.endsWith('service.yml'))).toBe(true);
    });

    it('should throw SecurityScanError when the manifest directory cannot be read', async () => {
      mockFs.readdir = jest.fn().mockRejectedValue(new Error('ENOENT'));
      await expect(scanner.scanKubernetesManifests('/nonexistent')).rejects.toThrow(
        SecurityScanError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // generateSecurityReport
  // -------------------------------------------------------------------------

  describe('generateSecurityReport', () => {
    it('should produce a SARIF 2.1.0-compliant structure', () => {
      const secretResult = scanner.scanSecrets('const k = "AKIAIOSFODNN7EXAMPLE";', 'f.ts');
      const report = scanner.generateSecurityReport([secretResult]);
      expect(report.version).toBe('2.1.0');
      expect(report.$schema).toContain('sarif');
      expect(Array.isArray(report.runs)).toBe(true);
      expect(report.runs[0]!.tool.driver.name).toBe('openclaw-security-scanner');
    });

    it('should map CRITICAL severity to SARIF level "error"', () => {
      const code = `const key = "AKIAIOSFODNN7EXAMPLE";`;
      const secretResult = scanner.scanSecrets(code, 'src.ts');
      const report = scanner.generateSecurityReport([secretResult]);
      const sarifResult = report.runs[0]!.results.find((r) => r.level === 'error');
      expect(sarifResult).toBeDefined();
    });

    it('should map MEDIUM severity to SARIF level "warning"', async () => {
      // Use a Dockerfile with a no-USER issue (MEDIUM) and no other issues
      const content = 'FROM node:20\nRUN echo hello\n';
      mockFs.readFile = jest.fn().mockResolvedValue(content);
      const dockerResult = await scanner.scanDockerfile('/fake/Dockerfile');
      // Inject a synthetic MEDIUM finding if the Dockerfile scan yields none
      const mediumFinding: SecurityFinding = {
        id: 'TEST-MEDIUM-L1',
        severity: 'MEDIUM',
        category: 'dockerfile-misconfiguration',
        title: 'Medium Issue',
        description: 'A medium severity issue.',
        file: '/fake/Dockerfile',
        line: 1,
        remediation: 'Fix it.',
        autoFixable: false,
      };
      const syntheticResult = { ...dockerResult, findings: [mediumFinding] };
      const report = scanner.generateSecurityReport([syntheticResult]);
      const warnResult = report.runs[0]!.results.find((r) => r.level === 'warning');
      expect(warnResult).toBeDefined();
    });

    it('should throw SecurityScanValidationError when argument is not an array', () => {
      expect(() =>
        scanner.generateSecurityReport(null as unknown as never[]),
      ).toThrow(SecurityScanValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // applyAutoFixes
  // -------------------------------------------------------------------------

  describe('applyAutoFixes', () => {
    it('should apply autoFixable findings and return applied count', async () => {
      const fileContent = '"lodash": "4.17.4"';
      mockFs.readFile = jest.fn().mockResolvedValue(fileContent);
      mockFs.writeFile = jest.fn().mockResolvedValue(undefined);

      const fixing: SecurityFinding = {
        id: 'DEP-CVE-001',
        severity: 'HIGH',
        category: 'dependency-vulnerability',
        title: 'Lodash Prototype Pollution',
        description: 'Vulnerable lodash version.',
        file: '/fake/package.json',
        line: null,
        remediation: 'Upgrade.',
        autoFixable: true,
        autoFix: {
          file: '/fake/package.json',
          line: null,
          oldContent: '"lodash": "4.17.4"',
          newContent: '"lodash": ">=4.17.21"',
          description: 'Bump lodash to >= 4.17.21',
        },
      };

      const result = await scanner.applyAutoFixes([fixing]);
      expect(result.applied).toBe(1);
      expect(result.skipped).toBe(0);
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    });

    it('should skip (not error) when oldContent is not found in the file', async () => {
      mockFs.readFile = jest.fn().mockResolvedValue('completely different content');
      mockFs.writeFile = jest.fn().mockResolvedValue(undefined);

      const fixing: SecurityFinding = {
        id: 'DEP-CVE-002',
        severity: 'HIGH',
        category: 'dependency-vulnerability',
        title: 'Test',
        description: 'desc',
        file: '/fake/package.json',
        line: null,
        remediation: 'Fix.',
        autoFixable: true,
        autoFix: {
          file: '/fake/package.json',
          line: null,
          oldContent: '"axios": "0.27.0"',
          newContent: '"axios": ">=1.6.0"',
          description: 'Bump axios',
        },
      };

      const result = await scanner.applyAutoFixes([fixing]);
      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should skip non-autoFixable findings entirely', async () => {
      const nonFixable: SecurityFinding = {
        id: 'SEC001-L1',
        severity: 'CRITICAL',
        category: 'hardcoded-secret',
        title: 'AWS Key',
        description: 'desc',
        file: '/fake/app.ts',
        line: 1,
        remediation: 'Remove key.',
        autoFixable: false,
      };

      const result = await scanner.applyAutoFixes([nonFixable]);
      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('should throw SecurityScanValidationError when argument is not an array', async () => {
      await expect(
        scanner.applyAutoFixes(null as unknown as SecurityFinding[]),
      ).rejects.toThrow(SecurityScanValidationError);
    });
  });
});
