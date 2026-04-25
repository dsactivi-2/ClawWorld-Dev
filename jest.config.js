'use strict';

/** @type {import('jest').Config} */
const config = {
  // Use ts-jest to handle TypeScript files directly
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Root directories Jest searches for tests and source files
  roots: ['<rootDir>/src', '<rootDir>/tests'],

  // Module file extensions in resolution order
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // Transform TypeScript with ts-jest
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        diagnostics: {
          ignoreCodes: ['TS151001'],
        },
      },
    ],
  },

  // Path aliases — mirrors tsconfig paths if any are added later
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // Test file patterns per suite
  testMatch: [
    // Unit tests
    '<rootDir>/tests/unit/**/*.test.ts',
    '<rootDir>/tests/unit/**/*.spec.ts',
    // Integration tests
    '<rootDir>/tests/integration/**/*.test.ts',
    '<rootDir>/tests/integration/**/*.spec.ts',
    // End-to-end tests
    '<rootDir>/tests/e2e/**/*.test.ts',
    '<rootDir>/tests/e2e/**/*.spec.ts',
    // Co-located tests inside src (unit only)
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/src/**/*.spec.ts',
  ],

  // Files/directories to ignore
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
  ],

  // Coverage collection
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    'skills/**/*.ts',
    'tools/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/**/types.ts',
    '!src/**/interfaces.ts',
    '!**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'clover', 'html'],
  coverageThreshold: {
    global: {
      branches: 25,
      functions: 30,
      lines: 30,
      statements: 30,
    },
  },

  // Global setup/teardown hooks (create these files when needed)
  // globalSetup: '<rootDir>/tests/setup/global-setup.ts',
  // globalTeardown: '<rootDir>/tests/setup/global-teardown.ts',
  // setupFilesAfterFramework: ['<rootDir>/tests/setup/jest.setup.ts'],

  // Timeout for async tests (ms)
  testTimeout: 30000,

  // Show individual test results
  verbose: true,

  // Clear mocks between every test
  clearMocks: true,
  resetMocks: false,
  restoreMocks: true,

  // Projects allow running unit/integration/e2e with different configs
  projects: [
    {
      displayName: 'unit',
      testMatch: [
        '<rootDir>/tests/unit/**/*.test.ts',
        '<rootDir>/tests/unit/**/*.spec.ts',
        '<rootDir>/src/**/*.test.ts',
        '<rootDir>/src/**/*.spec.ts',
      ],
      preset: 'ts-jest',
      testEnvironment: 'node',
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          { tsconfig: '<rootDir>/tsconfig.json' },
        ],
      },
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
    },
    {
      displayName: 'integration',
      testMatch: [
        '<rootDir>/tests/integration/**/*.test.ts',
        '<rootDir>/tests/integration/**/*.spec.ts',
      ],
      preset: 'ts-jest',
      testEnvironment: 'node',
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          { tsconfig: '<rootDir>/tsconfig.json' },
        ],
      },
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      testTimeout: 60000,
    },
    {
      displayName: 'e2e',
      testMatch: [
        '<rootDir>/tests/e2e/**/*.test.ts',
        '<rootDir>/tests/e2e/**/*.spec.ts',
      ],
      preset: 'ts-jest',
      testEnvironment: 'node',
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          { tsconfig: '<rootDir>/tsconfig.json' },
        ],
      },
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      testTimeout: 120000,
    },
  ],
};

module.exports = config;
