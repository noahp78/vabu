export const commands = {
  async find(args, ctx) {
    const [kind, role, flag, name, action] = args;
    if (args.length !== 5 || kind !== 'role' || flag !== '--name' || action !== 'click'
      || typeof role !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/i.test(role)
      || typeof name !== 'string' || !name.trim() || name.length > 256) {
      throw new Error('Usage: find role ROLE --name NAME click (nonblank NAME, at most 256 characters)');
    }
    if (typeof ctx?.findControl !== 'function' || typeof ctx.clickRef !== 'function') {
      throw new Error('Find-and-click is unsupported');
    }
    // The adapter matches the full scope and pins its document through the classic click.
    const match = await ctx.findControl({ role, name });
    const ref = match?.ref;
    if (typeof ref !== 'string' || !/^@r[1-9]\d{0,2}$/.test(ref)) {
      throw new Error('Find did not return a unique clickable control reference');
    }
    return ctx.clickRef(ref);
  },
};
