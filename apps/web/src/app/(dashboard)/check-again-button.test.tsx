// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '../../../test/render';
import { CheckAgainButton, STILL_NO_ORG } from './check-again-button';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('CheckAgainButton', () => {
  it('POSTs the sync and refreshes when an org was joined', async () => {
    const fetch = stubFetch(200, { joined: ['org_1'], left: [] });
    renderWithQuery(<CheckAgainButton />);
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      '/api/me/sync-orgs',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows the "still no organization" hint when nothing was joined', async () => {
    stubFetch(200, { joined: [], left: [] });
    renderWithQuery(<CheckAgainButton />);
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText(STILL_NO_ORG)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('explains a 429', async () => {
    stubFetch(429, { error: { code: 'rate_limited', message: 'slow down' } });
    renderWithQuery(<CheckAgainButton />);
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText(/too many checks/i)).toBeTruthy();
  });
});
