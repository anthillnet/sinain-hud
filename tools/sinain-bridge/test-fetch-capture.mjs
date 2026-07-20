globalThis.fetch = async (_url, options) => {
  process.stdout.write(options.body);
  return new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
