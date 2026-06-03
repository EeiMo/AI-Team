import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
    }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: false,
  testTimeout: 30000,
  setupFiles: ['<rootDir>/jest.setup.ts'],
  forceExit: true,
  maxWorkers: 1,  // 串行执行，避免集成测试共享 PG/Redis 导致数据冲突
  verbose: true,
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: '<rootDir>/../docs/test',
      outputName: 'junit-backend.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
      ancestorSeparator: ' › ',
    }],
  ],
};

export default config;
