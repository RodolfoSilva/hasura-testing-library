module.exports = {
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  roots: ['<rootDir>'],
  testRegex: '.*|(\\.|/)(test|spec))\\.(ts|js)?$',
  transform: {
    '^.+\\.ts?$': 'ts-jest',
  },
  verbose: true,
};
