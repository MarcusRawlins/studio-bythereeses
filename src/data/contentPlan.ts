export type Platform = 'Instagram' | 'TikTok'
export type Format = 'Carousel' | 'Reel' | 'Story' | 'TikTok'
export type Lane = 'Feed' | 'Reel' | 'Story' | 'TikTok'

export type ContentItem = {
  id: string
  scheduledFor: string
  platform: Platform
  format: Format
  lane: Lane
  status: 'Planned'
  title: string
  hook: string
  notes: string
}

export const contentItems: ContentItem[] = [
  {
    id: 'apr-01-1',
    scheduledFor: '2026-04-01',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'Bride getting ready in quiet detail',
    hook: 'The hands, the mirror, the dress, and the calm before the day opens up.',
    notes:
      'Seeded from the April plan. Strong save-driven bridal prep carousel that anchors the month and can spin off educational TikTok talking points.',
  },
  {
    id: 'apr-01-2',
    scheduledFor: '2026-04-01',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'Three things brides forget during getting ready',
    hook: 'A practical checklist post that ties directly to the bridal prep carousel.',
    notes:
      'Talking-head format. Easy to film, useful for planning couples, and designed for saves plus comments.',
  },
  {
    id: 'apr-01-3',
    scheduledFor: '2026-04-01',
    platform: 'Instagram',
    format: 'Story',
    lane: 'Story',
    status: 'Planned',
    title: 'Editing process behind the getting-ready set',
    hook: 'A quick behind-the-scenes story to show craft, not just finished frames.',
    notes: 'Good connective tissue between polished feed work and the working reality behind it.',
  },
  {
    id: 'apr-02-1',
    scheduledFor: '2026-04-02',
    platform: 'Instagram',
    format: 'Reel',
    lane: 'Reel',
    status: 'Planned',
    title: 'POV first look from a documentary angle',
    hook: 'Catching the first look without turning it into a performance.',
    notes:
      'Strong Reels concept. Emphasizes your unobtrusive approach and helps couples feel the moment instead of just observing it.',
  },
  {
    id: 'apr-02-2',
    scheduledFor: '2026-04-02',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'The one thing I tell every bride before photos',
    hook: 'Simple advice delivered directly to camera with a curiosity gap.',
    notes:
      'Positions you as a guide, not just a vendor. Useful conversion content for newly engaged couples.',
  },
  {
    id: 'apr-03-1',
    scheduledFor: '2026-04-03',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'Private vows before the ceremony',
    hook: 'The emotional weight of the moment before anyone else sees them.',
    notes:
      'Private vows are still a discovery topic for planning couples, so this works as both inspiration and education.',
  },
  {
    id: 'apr-03-2',
    scheduledFor: '2026-04-03',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'What to wear for your engagement session',
    hook: 'Styled, practical, and intentionally platform-native.',
    notes:
      'Search-aligned advice content. Good top-of-funnel educational post even though engagement sessions stay off the main feed.',
  },
  {
    id: 'apr-04-1',
    scheduledFor: '2026-04-04',
    platform: 'Instagram',
    format: 'Reel',
    lane: 'Reel',
    status: 'Planned',
    title: 'A wedding day with a husband-wife team',
    hook: 'From early coffee to the final review, show the full arc together.',
    notes:
      'One of the clearest differentiators in the April calendar. Helps carve out an ownable position against other luxury wedding photographers.',
  },
  {
    id: 'apr-04-2',
    scheduledFor: '2026-04-04',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'What it is actually like to shoot with your spouse',
    hook: 'Same footage, different framing, more conversational delivery.',
    notes:
      'Good example of a repurposed lane where the core idea stays the same but the caption and pacing change for TikTok.',
  },
  {
    id: 'apr-05-1',
    scheduledFor: '2026-04-05',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'Reception candids that feel alive',
    hook: 'The laughter, dancing, and unscripted joy that usually gets under-posted.',
    notes:
      'Reception work is a useful content gap. This brings in energy and keeps the feed from feeling too ceremony-heavy.',
  },
  {
    id: 'apr-06-1',
    scheduledFor: '2026-04-06',
    platform: 'Instagram',
    format: 'Reel',
    lane: 'Reel',
    status: 'Planned',
    title: 'How we move through a wedding day without interrupting it',
    hook: 'A values-driven reel about presence, trust, and watching carefully.',
    notes:
      'Strong positioning asset. It explains documentary coverage through experience rather than just label language.',
  },
  {
    id: 'apr-06-2',
    scheduledFor: '2026-04-06',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'The difference between being photographed and being watched',
    hook: 'A sharper version of the same thesis for comments and conversation.',
    notes:
      'Useful as a belief-driven TikTok with minimal production overhead and a strong chance of replies.',
  },
  {
    id: 'apr-07-1',
    scheduledFor: '2026-04-07',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'Parent reactions during the ceremony',
    hook: 'The ceremony photos couples usually do not realize they will treasure most.',
    notes:
      'A solid example of how documentary imagery supports emotional discovery content for couples.',
  },
  {
    id: 'apr-08-1',
    scheduledFor: '2026-04-08',
    platform: 'Instagram',
    format: 'Reel',
    lane: 'Reel',
    status: 'Planned',
    title: 'The calm before the ceremony',
    hook: 'An atmosphere-first reel with just enough narration to orient the viewer.',
    notes:
      'Helps the account feel editorial and not only educational. Strong mood-setting content for brand tone.',
  },
  {
    id: 'apr-09-1',
    scheduledFor: '2026-04-09',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'Golden hour portraits that still feel natural',
    hook: 'Use a portrait set without losing the documentary identity.',
    notes:
      'Important balancing content because couples still expect portrait work, but the framing keeps it aligned with your brand.',
  },
  {
    id: 'apr-10-1',
    scheduledFor: '2026-04-10',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'Why I care more about the in-between than the obvious photo',
    hook: 'A creator thesis statement that works well as a talking-head post.',
    notes:
      'Good candidate for Ed-led research expansion because it maps cleanly to both philosophy and examples.',
  },
  {
    id: 'apr-11-1',
    scheduledFor: '2026-04-11',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'A wedding day told in hands',
    hook: 'Use one visual constraint to make the whole set more memorable.',
    notes:
      'Editorial concept post. Great for saves and for proving the account has an intentional visual language.',
  },
  {
    id: 'apr-13-1',
    scheduledFor: '2026-04-13',
    platform: 'Instagram',
    format: 'Reel',
    lane: 'Reel',
    status: 'Planned',
    title: 'What photographers mean by documentary',
    hook: 'Explain the term without sounding abstract or vague.',
    notes:
      'Useful category-definition content. Helps the right couples self-identify faster.',
  },
  {
    id: 'apr-14-1',
    scheduledFor: '2026-04-14',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'What I notice in ceremony spaces before anyone walks in',
    hook: 'Observational expertise content that feels quiet but authoritative.',
    notes:
      'Good TikTok research lane because the framing can branch into venue light, flow, or emotion.',
  },
  {
    id: 'apr-15-1',
    scheduledFor: '2026-04-15',
    platform: 'Instagram',
    format: 'Reel',
    lane: 'Reel',
    status: 'Planned',
    title: 'Why first looks still matter',
    hook: 'A practical answer for couples who are excited and hesitant at the same time.',
    notes:
      'This is the natural midpoint post for the month and a clean anchor for the current week in the dashboard.',
  },
  {
    id: 'apr-16-1',
    scheduledFor: '2026-04-16',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'The quiet portraits right after the ceremony',
    hook: 'The first private breath after the formal moment is over.',
    notes:
      'Keeps the month emotionally sequenced rather than feeling like unrelated individual posts.',
  },
  {
    id: 'apr-18-1',
    scheduledFor: '2026-04-18',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'Why I watch the room during speeches, not just the mic',
    hook: 'Toast coverage is really about reactions and relationships.',
    notes:
      'A useful example of explaining your eye instead of just showing final images.',
  },
  {
    id: 'apr-21-1',
    scheduledFor: '2026-04-21',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'What bridal prep feels like when the room is right',
    hook: 'Bring the month back to a proven save-driving theme with a more refined point of view.',
    notes:
      'Revisits a strong category without repeating the exact same framing from the first week.',
  },
  {
    id: 'apr-22-1',
    scheduledFor: '2026-04-22',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'Documentary does not mean zero direction',
    hook: 'A concise myth-busting post with a strong opening line.',
    notes:
      'Likely to generate comments because it corrects a common misunderstanding in a clear, confident way.',
  },
  {
    id: 'apr-24-1',
    scheduledFor: '2026-04-24',
    platform: 'Instagram',
    format: 'Reel',
    lane: 'Reel',
    status: 'Planned',
    title: 'The vendors who make wedding days feel effortless',
    hook: 'Relationship-building content that still serves couples.',
    notes:
      'Useful for network effects and a good reminder that the content engine should support referrals too.',
  },
  {
    id: 'apr-27-1',
    scheduledFor: '2026-04-27',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'Unpopular wedding photography opinions',
    hook: 'A sharper belief-driven post designed for shares, saves, and debate.',
    notes:
      'One of the more reach-oriented concepts in the calendar. Strong option for Ed to expand into research-backed points.',
  },
  {
    id: 'apr-28-1',
    scheduledFor: '2026-04-28',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'Five things couples should know before hiring a photographer',
    hook: 'High-intent planning advice with clear save and conversion value.',
    notes:
      'A foundational educational post that likely deserves long-term tracking in both Studio and Obsidian.',
  },
  {
    id: 'apr-29-1',
    scheduledFor: '2026-04-29',
    platform: 'Instagram',
    format: 'Reel',
    lane: 'Reel',
    status: 'Planned',
    title: 'Red flags in a wedding photographer portfolio',
    hook: 'Opinionated, practical, and built for resharing in DMs.',
    notes:
      'This is one of the most likely April ideas to branch into follow-up posts, comments, and objections.',
  },
  {
    id: 'apr-30-1',
    scheduledFor: '2026-04-30',
    platform: 'Instagram',
    format: 'Carousel',
    lane: 'Feed',
    status: 'Planned',
    title: 'April recap with the strongest images of the month',
    hook: 'A greatest-hits post that doubles as a content audit.',
    notes:
      'Useful close-of-month checkpoint for what performed, what should be repurposed, and what should be researched deeper.',
  },
  {
    id: 'apr-30-2',
    scheduledFor: '2026-04-30',
    platform: 'TikTok',
    format: 'TikTok',
    lane: 'TikTok',
    status: 'Planned',
    title: 'What a month of shooting weddings actually looks like',
    hook: 'A real-version recap that emphasizes process, pace, and range.',
    notes:
      'Strong closing TikTok concept and a good bridge into May planning plus future research prompts.',
  },
]
