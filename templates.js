/** Paths returned in API `structure`; folders are materialized via `.gitkeep` commits. */

export const TEMPLATE_STRUCTURES = {
  'node-express-api': [
    'src/controllers',
    'src/routes',
    'src/middleware',
    'src/models',
    'src/config',
    'tests',
    '.gitignore',
    'README.md',
    'server.js',
  ],
  'react-frontend': [
    'src/components',
    'src/pages',
    'src/hooks',
    'src/utils',
    'public',
    '.gitignore',
    'README.md',
    'package.json',
  ],
  'python-ml': [
    'data/raw',
    'data/processed',
    'notebooks',
    'src/models',
    'src/features',
    'tests',
    'requirements.txt',
    'README.md',
    'main.py',
  ],
  'fullstack-mern': [
    'client/src/components',
    'client/src/pages',
    'server/src/routes',
    'server/src/models',
    'server/src/middleware',
    '.gitignore',
    'README.md',
    'docker-compose.yml',
  ],
  'react-native-mobile': [
    'src/screens',
    'src/components',
    'src/navigation',
    'src/hooks',
    'src/store',
    '.gitignore',
    'README.md',
    'App.js',
  ],
}

const GITKEEP = ''

function nodeGitignore() {
  return `node_modules/
.env
.env.local
dist/
build/
*.log
.DS_Store
`
}

function pythonGitignore() {
  return `__pycache__/
*.py[cod]
.env
.venv/
venv/
data/raw/*
!data/raw/.gitkeep
data/processed/*
!data/processed/.gitkeep
.ipynb_checkpoints/
.DS_Store
`
}

function readme(title, stack) {
  return `# ${title}

${stack}

Generated with Repo Generator.
`
}

/** @returns {{ path: string, content: string }[]} */
export function getFilesToCreate(template, repoName, description) {
  const desc = description || 'Generated repository'
  const structure = TEMPLATE_STRUCTURES[template]
  if (!structure) return null

  const files = []

  for (const entry of structure) {
    if (entry === '.gitignore' || entry === 'README.md' || entry.endsWith('.js') || entry.endsWith('.json') || entry.endsWith('.yml') || entry.endsWith('.txt') || entry.endsWith('.py')) {
      continue
    }
    files.push({ path: `${entry}/.gitkeep`, content: GITKEEP })
  }

  if (template === 'node-express-api') {
    files.push(
      { path: '.gitignore', content: nodeGitignore() },
      {
        path: 'README.md',
        content: readme(repoName, 'Node.js Express API scaffold.'),
      },
      {
        path: 'server.js',
        content: `const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true, service: '${repoName}' });
});

app.listen(PORT, () => {
  console.log(\`Server listening on http://localhost:\${PORT}\`);
});
`,
      },
    )
  } else if (template === 'react-frontend') {
    files.push(
      { path: '.gitignore', content: nodeGitignore() },
      {
        path: 'README.md',
        content: readme(repoName, 'React (Vite) frontend scaffold.'),
      },
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: repoName.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'react-app',
            private: true,
            version: '0.0.0',
            type: 'module',
            scripts: {
              dev: 'vite',
              build: 'vite build',
              preview: 'vite preview',
            },
            dependencies: {
              react: '^18.3.1',
              'react-dom': '^18.3.1',
            },
            devDependencies: {
              '@vitejs/plugin-react': '^4.3.4',
              vite: '^6.0.3',
            },
          },
          null,
          2,
        ),
      },
    )
  } else if (template === 'python-ml') {
    files.push(
      { path: '.gitignore', content: pythonGitignore() },
      {
        path: 'README.md',
        content: readme(repoName, 'Python ML project scaffold.'),
      },
      {
        path: 'requirements.txt',
        content: `# ${desc}
numpy>=1.26
pandas>=2.0
scikit-learn>=1.3
`,
      },
      {
        path: 'main.py',
        content: `"""Entry point for ${repoName}."""


def main() -> None:
    print("Hello from ${repoName}")


if __name__ == "__main__":
    main()
`,
      },
    )
  } else if (template === 'fullstack-mern') {
    files.push(
      { path: '.gitignore', content: nodeGitignore() },
      {
        path: 'README.md',
        content: readme(repoName, 'MERN-style monorepo (client + server).'),
      },
      {
        path: 'docker-compose.yml',
        content: `services:
  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db

volumes:
  mongo_data:
`,
      },
    )
  } else if (template === 'react-native-mobile') {
    files.push(
      { path: '.gitignore', content: nodeGitignore() },
      {
        path: 'README.md',
        content: readme(repoName, 'React Native mobile app scaffold.'),
      },
      {
        path: 'App.js',
        content: `import React from 'react';
import { SafeAreaView, Text, StyleSheet } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>${repoName}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '600' },
});
`,
      },
    )
  }

  return files
}
