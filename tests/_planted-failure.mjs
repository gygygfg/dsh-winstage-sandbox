/** 故意失败的测试，仅用于验证 autotest 能正确检出失败。不属于交付套件。 */
process.stdout.write('  ✗ 这是一个人为制造的失败\n')
process.exit(1)
