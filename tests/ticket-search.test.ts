import { describe, expect, it } from 'vitest'
import { ticketNumberList } from '../shared/utils/ticket-search'

describe('ticketNumberList', () => {
  it('reads numbers separated by commas, spaces or both', () => {
    expect(ticketNumberList('12, 15')).toEqual([12, 15])
    expect(ticketNumberList('12 15 20')).toEqual([12, 15, 20])
    expect(ticketNumberList('12,15')).toEqual([12, 15])
    expect(ticketNumberList('  12 ,  15,  ')).toEqual([12, 15])
  })

  it('accepts the # people write in front of a number', () => {
    expect(ticketNumberList('#12 #15')).toEqual([12, 15])
    expect(ticketNumberList('#12, 15')).toEqual([12, 15])
  })

  it('leaves a single number to the text search', () => {
    expect(ticketNumberList('12')).toBeNull()
    expect(ticketNumberList('#12')).toBeNull()
    expect(ticketNumberList('12,')).toBeNull()
  })

  it('leaves anything with words in it to the text search', () => {
    expect(ticketNumberList('')).toBeNull()
    expect(ticketNumberList('iOS 19')).toBeNull()
    expect(ticketNumberList('12, crash')).toBeNull()
    expect(ticketNumberList('1.4.0 42')).toBeNull()
  })
})
