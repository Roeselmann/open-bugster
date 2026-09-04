import { describe, expect, it } from 'vitest'
import {
  describeIssue, formatJqlDate, isJiraSiteUrl, issueUrl, jiraPriorityToBugster, normalizeSiteUrl, titleFromIssue, tokenLabel
} from '../server/utils/jira-policy'

describe('Jira import policy', () => {
  it('reduces whatever was pasted to the site it belongs to', () => {
    expect(normalizeSiteUrl('https://team.atlassian.net')).toBe('https://team.atlassian.net')
    expect(normalizeSiteUrl('https://team.atlassian.net/')).toBe('https://team.atlassian.net')
    expect(normalizeSiteUrl('https://team.atlassian.net/browse/APP-1?x=1')).toBe('https://team.atlassian.net')
    expect(normalizeSiteUrl('team.atlassian.net')).toBe('https://team.atlassian.net')
    expect(normalizeSiteUrl('  ')).toBe('')
  })

  it('accepts only an https origin as a site', () => {
    expect(isJiraSiteUrl('https://team.atlassian.net')).toBe(true)
    expect(isJiraSiteUrl('http://team.atlassian.net')).toBe(false)
    // A mock on this machine may speak plain http; nothing else may.
    expect(isJiraSiteUrl('http://localhost:4010')).toBe(true)
    expect(isJiraSiteUrl('https://team.atlassian.net/jira')).toBe(false)
    expect(isJiraSiteUrl('not a url')).toBe(false)
  })

  it('formats a timestamp the way the description’s comment headings need it', () => {
    expect(formatJqlDate(new Date('2026-05-26T12:07:00.000Z'))).toBe('2026-05-26 12:07')
  })

  it('maps Jira’s priorities onto the board’s four', () => {
    expect(jiraPriorityToBugster('Highest')).toBe('urgent')
    expect(jiraPriorityToBugster('Blocker')).toBe('urgent')
    expect(jiraPriorityToBugster('High')).toBe('high')
    expect(jiraPriorityToBugster('Medium')).toBe('medium')
    expect(jiraPriorityToBugster('Low')).toBe('low')
    expect(jiraPriorityToBugster('Lowest')).toBe('low')
    expect(jiraPriorityToBugster('Someday')).toBe('medium')
    expect(jiraPriorityToBugster(null)).toBe('medium')
  })

  it('titles, links and labels an issue', () => {
    expect(titleFromIssue('APP-1', '  Crash   on launch ')).toBe('Crash on launch')
    expect(titleFromIssue('APP-1', null)).toBe('APP-1')
    expect(issueUrl('https://team.atlassian.net/', 'APP-1')).toBe('https://team.atlassian.net/browse/APP-1')
    expect(tokenLabel('ATATT3xFfGF0abcd1234')).toBe('Token · …1234')
    expect(tokenLabel('  ATATT3xFfGF0abcd1234  ')).toBe('Token · …1234')
  })

  it('folds Jira’s comments under the description', () => {
    const description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] }
    const comments = [
      { author: 'Ada Lovelace', created: '2026-08-20T09:30:00.000Z', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reproduced.' }] }] } },
      { author: null, created: null, body: 'plain text comment' },
      { author: 'Nobody', created: null, body: { type: 'doc', content: [] } }
    ]
    expect(describeIssue(description, comments)).toBe([
      'Body',
      '',
      '## Comments from Jira',
      '',
      '**Ada Lovelace** · 2026-08-20 09:30 UTC',
      '',
      'Reproduced.',
      '',
      '---',
      '',
      '**Unknown**',
      '',
      'plain text comment'
    ].join('\n'))
    expect(describeIssue(description, [])).toBe('Body')
    expect(describeIssue(null, [])).toBe('')
  })
})
