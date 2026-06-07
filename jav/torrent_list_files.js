#!/usr/bin/env node

'use strict';

const DEFAULT_TIMEOUT_MS = 60_000;

function printUsage() {
  console.log(`用法:
  node jav/torrent_list_files.js --magnet "<磁力链>"

选项:
  --magnet <磁力链>  要解析的磁力链
  --help, -h         显示帮助

提示:
  磁力链通常包含 "&"，请使用引号包裹。`);
}

function parseArgs(argv) {
  let magnet = '';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      return { help: true, magnet: '' };
    }

    if (argument === '--magnet') {
      magnet = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (argument.startsWith('--magnet=')) {
      magnet = argument.slice('--magnet='.length);
      continue;
    }

    throw new Error(`未知参数: ${argument}`);
  }

  return { help: false, magnet };
}

function validateMagnet(magnet) {
  if (!magnet) {
    throw new Error('缺少必需参数 --magnet。');
  }

  if (!magnet.startsWith('magnet:?')) {
    throw new Error('--magnet 必须是有效的磁力链。');
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '未知大小';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / (1024 ** unitIndex);
  const digits = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;

  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function createDirectoryNode(name) {
  return {
    name,
    type: 'directory',
    children: new Map(),
  };
}

function buildTree(files, rootName) {
  const root = createDirectoryNode('');

  for (const file of files) {
    const parts = file.path.split(/[\\/]+/).filter(Boolean);

    if (parts.length > 1 && parts[0] === rootName) {
      parts.shift();
    }

    let current = root;

    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const isFile = index === parts.length - 1;

      if (isFile) {
        current.children.set(name, {
          name,
          type: 'file',
          length: file.length,
        });
      } else {
        const existing = current.children.get(name);

        if (existing?.type === 'file') {
          throw new Error(`种子目录结构冲突: ${file.path}`);
        }

        if (!existing) {
          current.children.set(name, createDirectoryNode(name));
        }

        current = current.children.get(name);
      }
    }
  }

  return root;
}

function sortNodes(nodes) {
  return [...nodes].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }

    return left.name.localeCompare(right.name, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function printTree(node, prefix = '') {
  const children = sortNodes(node.children.values());

  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    const connector = isLast ? '`-- ' : '|-- ';
    const suffix = child.type === 'file' ? ` (${formatBytes(child.length)})` : '/';

    console.log(`${prefix}${connector}${child.name}${suffix}`);

    if (child.type === 'directory') {
      printTree(child, `${prefix}${isLast ? '    ' : '|   '}`);
    }
  });
}

async function loadWebTorrent() {
  try {
    const module = await import('webtorrent');
    return module.default;
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('未安装 webtorrent。请先执行: npm install webtorrent');
    }

    throw error;
  }
}

async function getTorrentMetadata(WebTorrent, magnet) {
  const client = new WebTorrent();

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;

      const finish = (callback, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        callback(value);
      };

      const timeout = setTimeout(() => {
        finish(
          reject,
          new Error(`获取种子元数据超时（${DEFAULT_TIMEOUT_MS / 1000} 秒）。`),
        );
      }, DEFAULT_TIMEOUT_MS);

      try {
        const torrent = client.add(magnet, { deselect: true }, (readyTorrent) => {
          finish(resolve, {
            name: readyTorrent.name || readyTorrent.infoHash,
            infoHash: readyTorrent.infoHash,
            length: readyTorrent.length,
            files: readyTorrent.files.map((file) => ({
              path: file.path,
              length: file.length,
            })),
          });
        });

        torrent.once('error', (error) => finish(reject, error));
        client.once('error', (error) => finish(reject, error));
      } catch (error) {
        finish(reject, error);
      }
    });
  } finally {
    if (!client.destroyed) {
      await new Promise((resolve, reject) => {
        client.destroy((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  validateMagnet(args.magnet);

  const WebTorrent = await loadWebTorrent();
  const metadata = await getTorrentMetadata(WebTorrent, args.magnet);
  const tree = buildTree(metadata.files, metadata.name);

  console.log(`${metadata.name}/`);
  printTree(tree);
  console.log('');
  console.log(`文件数: ${metadata.files.length}`);
  console.log(`总大小: ${formatBytes(metadata.length)}`);
  console.log(`Info Hash: ${metadata.infoHash}`);
}

main().catch((error) => {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
});
