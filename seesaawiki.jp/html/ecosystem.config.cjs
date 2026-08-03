module.exports = {
  apps: [
    {
      name: 'seesaawiki_jp_server',
      script: 'C:/Windows/System32/cmd.exe',
      args: ['/c', 'npx', 'serve', '.', '-l', '9202', '--config', '.serve.json'],
      cwd: __dirname,
      interpreter: 'none'
    },
  ],
};
