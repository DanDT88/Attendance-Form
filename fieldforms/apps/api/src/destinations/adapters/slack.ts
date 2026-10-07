import type { DestinationSettings } from '@fieldforms/shared';
import { postToSlack, slackHookUrl, slackTarget } from '../connections/slack.js';
import { DeliveryError, type DestinationAdapter } from '../types.js';

/**
 * Slack destination: posts the rendered message template to the connection's incoming webhook.
 * Values are escaped for Slack (`&`, `<`, `>`), so an answer cannot mention @channel or forge a
 * link; only the admin's own template text can. No files are sent.
 */
type Settings = DestinationSettings<'slack'>;

/** Slack cuts messages at 40,000 characters; stay below it without splitting an entity or link. */
const MAX_TEXT = 39_000;

export const slackAdapter: DestinationAdapter<Settings> = {
  kind: 'slack',

  async deliver(ctx, s, conn, env) {
    const url = slackHookUrl(conn, env);
    const rendered = (await ctx.liquid(s.message, 'slack')).trim();
    if (!rendered)
      throw new DeliveryError('The Slack message is empty', {
        permanent: true,
        errorClass: 'settings',
      });
    let text = `${ctx.test ? '[TEST] ' : ''}${rendered}`;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT).replace(/&[a-z]*$|<[^>]*$/, '');
    const status = await postToSlack(url, text, env, conn?.secrets ?? {});
    return { outcome: 'delivered', target: slackTarget(conn), evidence: { status } };
  },
};
