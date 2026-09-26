// Fails the way real servers do: echoes its argv, token included, to stderr.
process.stderr.write(`bad arguments: ${process.argv.slice(2).join(' ')}\n`);
process.exit(1);
