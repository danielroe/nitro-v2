export default eventHandler((event) => {
  const query = getQuery(event);
  if (query.unhandled !== undefined) {
    throw new Error("Unhandled error");
  }
  if (query.own !== undefined) {
    setResponseHeader(event, "cache-control", "private, max-age=10");
  }
  throw createError({ statusCode: 401 });
});
