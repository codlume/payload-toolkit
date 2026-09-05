// Node does not load Payload UI's styles; leave JavaScript resolution unchanged.
export const load = (url, context, nextLoad) => {
  if (url.endsWith(".css") || url.endsWith(".scss")) {
    return { format: "module", shortCircuit: true, source: "export default undefined;" };
  }
  return nextLoad(url, context);
};
