# Contributing to CardMint

First off, thank you for considering contributing to CardMint! It's people like you that make CardMint such a great tool for the Pokemon card collecting community.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Style Guidelines](#style-guidelines)
- [Pull Request Process](#pull-request-process)
- [Community](#community)

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to [conduct@cardmint.io].

## Getting Started

CardMint is a high-performance Pokemon card scanning and inventory management system. Before contributing, please:

1. Read the [README.md](README.md) to understand the project
2. Review the [ARCHITECTURE.md](docs/ARCHITECTURE.md) to understand the system design
3. Check the [Issues](https://github.com/yourusername/cardmint/issues) for existing discussions
4. Review our [Security Policy](SECURITY.md) for security-related contributions

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, please include:

- **Clear and descriptive title**
- **Exact steps to reproduce** the problem
- **Expected behavior** vs what actually happened
- **Screenshots** if applicable
- **System information** (OS, Node version, etc.)
- **Log output** with relevant error messages

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **Use case**: Why is this enhancement needed?
- **Proposed solution**: How should it work?
- **Alternatives considered**: What other solutions did you consider?
- **Additional context**: Mockups, diagrams, examples

### Code Contributions

#### First Time Contributors

Look for issues labeled:
- `good first issue` - Simple issues perfect for beginners
- `help wanted` - Issues where we need community help
- `documentation` - Documentation improvements

#### Areas We Need Help

1. **Testing**: Increasing test coverage (currently targeting 80%+)
2. **OCR Accuracy**: Improving card text recognition
3. **Performance**: Optimization for faster processing
4. **Documentation**: API docs, tutorials, examples
5. **Security**: Vulnerability fixes and hardening
6. **UI/UX**: Dashboard improvements
7. **Database**: Query optimization
8. **CI/CD**: GitHub Actions workflows

## Development Setup

### Prerequisites

- Node.js >= 20.0.0
- PostgreSQL 16+
- Redis 7+
- Git
- Optional: CUDA-capable GPU for acceleration

### Local Development

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/yourusername/cardmint.git
   cd cardmint
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Set up databases**
   ```bash
   ./setup-postgres.sh
   # Start Redis
   redis-server
   ```

5. **Run migrations**
   ```bash
   npm run db:migrate
   ```

6. **Start development server**
   ```bash
   npm run dev
   ```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test suite
npm test -- --testPathPattern=cardMatcher

# Run in watch mode
npm test -- --watch
```

### Building

```bash
# TypeScript compilation
npm run build

# Type checking only
npm run typecheck

# Linting
npm run lint
```

## Style Guidelines

### TypeScript Style

- Use TypeScript for all new code
- Follow existing code patterns
- Prefer interfaces over types for object shapes
- Use explicit return types for functions
- Document complex logic with comments

### Code Style

```typescript
// Good
export interface CardData {
  id: string;
  name: string;
  set: string;
  number: string;
}

export async function processCard(data: CardData): Promise<ProcessedCard> {
  // Implementation
}

// Bad
export type card_data = {
  id: string,
  Name: string,
  SET: string,
  num: string
}

export async function process(d: any) {
  // Implementation
}
```

### Commit Messages

Follow conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Test additions or changes
- `chore:` Maintenance tasks
- `perf:` Performance improvements

Examples:
```
feat: add card duplicate detection
fix: resolve memory leak in image processor
docs: update API documentation for v1.0
perf: optimize database queries for card search
```

### Testing Standards

- Write tests for new features
- Maintain or increase coverage
- Test edge cases and error conditions
- Use descriptive test names

```typescript
// Good test name
describe('CardMatcher', () => {
  it('should achieve 99.9% accuracy with high-confidence matches', () => {
    // Test implementation
  });
});

// Bad test name
describe('CM', () => {
  it('works', () => {
    // Test implementation
  });
});
```

## Pull Request Process

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write tests for new functionality
   - Update documentation
   - Follow style guidelines

3. **Ensure quality**
   - Run tests: `npm test`
   - Check types: `npm run typecheck`
   - Lint code: `npm run lint`
   - Security audit: `npm audit`

4. **Commit your changes**
   - Use conventional commit messages
   - Keep commits focused and atomic

5. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```

6. **Create Pull Request**
   - Use the PR template
   - Link related issues
   - Provide clear description
   - Include screenshots if UI changes

7. **Code Review**
   - Address reviewer feedback
   - Keep PR updated with main branch
   - Be patient and respectful

### Pull Request Checklist

- [ ] Tests pass locally
- [ ] Code follows style guidelines
- [ ] Documentation updated
- [ ] No hardcoded values or credentials
- [ ] Security considerations addressed
- [ ] Performance impact considered
- [ ] Breaking changes documented

## Project Structure

```
CardMint/
├── src/
│   ├── api/          # REST API endpoints
│   ├── camera/       # Camera integration
│   ├── services/     # Business logic
│   ├── utils/        # Utilities
│   └── types/        # TypeScript types
├── test/
│   ├── unit/         # Unit tests
│   ├── integration/  # Integration tests
│   └── e2e/          # End-to-end tests
├── docs/             # Documentation
└── scripts/          # Utility scripts
```

## Testing Philosophy

- **Unit Tests**: Test individual functions/classes in isolation
- **Integration Tests**: Test component interactions
- **E2E Tests**: Test complete user workflows
- **Performance Tests**: Validate speed requirements

## Common Issues

### Issue: Tests failing with missing dependencies
**Solution**: Run `npm install` and ensure all services are running

### Issue: Database connection errors
**Solution**: Check PostgreSQL is running and `.env` is configured

### Issue: OCR accuracy below threshold
**Solution**: Ensure proper lighting and image quality

## Recognition

Contributors who make significant improvements will be recognized in:
- The README.md contributors section
- Release notes
- The project website (coming soon)

## Questions?

Feel free to:
- Open a [Discussion](https://github.com/yourusername/cardmint/discussions)
- Join our Discord server (coming soon)
- Email: [contributors@cardmint.io]

## License

By contributing to CardMint, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to CardMint! 🎉

*Last updated: August 2025*