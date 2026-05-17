import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, firstValueFrom, from, map, throwError } from 'rxjs';

import { CatalogEntitySummary, PerformerProfile } from '../../models';

const iafdOrigin = 'https://www.iafd.com';

@Injectable({
  providedIn: 'root',
})
export class IafdProfileService {
  private readonly http = inject(HttpClient);

  fetchProfileForPerformer(
    summary: CatalogEntitySummary,
    rawUrl: string,
  ): Observable<PerformerProfile> {
    const iafdUrl = this.normalizeIafdUrl(rawUrl);

    if (!iafdUrl) {
      return throwError(() => new Error('The URL must be a valid IAFD performer page.'));
    }

    return this.fetchIafdDocument(iafdUrl).pipe(
      map((html) => {
        if (!isIafdProfilePage(html)) {
          throw new Error('The URL did not resolve to an IAFD performer profile page.');
        }

        return this.parseProfile(summary, iafdUrl, html);
      }),
    );
  }

  private fetchIafdDocument(iafdUrl: string): Observable<string> {
    const localProxy = `http://localhost:3789/fetch?url=${encodeURIComponent(iafdUrl)}`;

    const promise = (async () => {
      try {
        return await firstValueFrom(this.http.get(localProxy, { responseType: 'text' }));
      } catch {
        try {
          return await firstValueFrom(this.http.get(iafdUrl, { responseType: 'text' }));
        } catch {
          throw new Error(
            'Unable to load the IAFD page. Start the local proxy with `npm run start:proxy` and try again.',
          );
        }
      }
    })();

    return from(promise).pipe(
      catchError((error: unknown) =>
        throwError(
          () =>
            (error instanceof Error
              ? error
              : new Error(
                  'Unable to load the IAFD page. Start the local proxy with `npm run start:proxy` and try again.',
                )),
        ),
      ),
    );
  }

  private normalizeIafdUrl(value: string): string | undefined {
    try {
      const url = new URL(value.trim());

      if (!url.hostname.includes('iafd.com')) {
        return undefined;
      }

      if (!url.pathname.startsWith('/person.rme/')) {
        return undefined;
      }

      url.protocol = 'https:';
      url.hostname = 'www.iafd.com';
      url.hash = '';

      return url.href.startsWith(iafdOrigin) ? url.href : undefined;
    } catch {
      return undefined;
    }
  }

  private parseProfile(
    summary: CatalogEntitySummary,
    iafdUrl: string,
    html: string,
  ): PerformerProfile {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const bio = collectBioFields(document);
    const yearsActive = bio.get('years active');
    const name = cleanValue(document.querySelector('h1')?.textContent) ?? summary.name;

    return removeEmptyValues<PerformerProfile>({
      id: summary.id,
      name,
      searchName: summary.searchName,
      completed: true,
      isPerformer: true,
      aka: splitLines(bio.get('performer aka')),
      birthday: removeParentheticalAge(bio.get('birthday')),
      yearsActive,
      ageStarted: extractAgeStarted(yearsActive),
      ethnicity: bio.get('ethnicity'),
      nationality: bio.get('nationality'),
      hairColor: bio.get('hair colors') ?? bio.get('hair color'),
      eyeColor: bio.get('eye color'),
      height: bio.get('height'),
      weight: bio.get('weight'),
      measurements: bio.get('measurements'),
      shoeSize: bio.get('shoe size'),
      databases: extractDatabases(document),
      credits: extractMovieCreditsFromDocument(document),
      dataLinks: [{ label: 'IAFD', source: 'iafd', url: iafdUrl }],
    });
  }
}

function collectBioFields(document: Document): Map<string, string> {
  const fields = new Map<string, string>();

  for (const heading of Array.from(document.querySelectorAll('.bioheading'))) {
    const label = normalizeText(heading.textContent ?? '');
    const values: string[] = [];
    let sibling: ChildNode | null = heading.nextSibling;

    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE) {
        const element = sibling as Element;

        if (
          element.classList.contains('bioheading') ||
          ['corrections', 'persontitlead'].includes(element.id)
        ) {
          break;
        }
      }

      const text = cleanMultilineValue(nodeToText(sibling));

      if (text) {
        values.push(text);
      }

      sibling = sibling.nextSibling;
    }

    const value = cleanMultilineValue(values.join('\n'));

    if (label && value) {
      fields.set(label, value);
    }
  }

  return fields;
}

function nodeToText(node: ChildNode): string {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return node.textContent ?? '';
  }

  const clone = node.cloneNode(true) as Element;

  for (const lineBreak of Array.from(clone.querySelectorAll('br'))) {
    lineBreak.replaceWith('\n');
  }

  return clone.textContent ?? '';
}

function extractDatabases(
  document: Document,
): readonly { label: string; url: string }[] | undefined {
  const databaseHeading = Array.from(document.querySelectorAll('.bioheading')).find(
    (heading) => normalizeText(heading.textContent ?? '') === 'databases',
  );

  if (!databaseHeading) {
    return undefined;
  }

  const links: { label: string; url: string }[] = [];
  let sibling: ChildNode | null = databaseHeading.nextSibling;

  while (sibling) {
    if (sibling.nodeType === Node.ELEMENT_NODE) {
      const element = sibling as Element;

      if (element.classList.contains('bioheading')) {
        break;
      }

      if (['corrections', 'persontitlead'].includes(element.id)) {
        break;
      }

      const anchors = element.matches('a')
        ? [element as HTMLAnchorElement]
        : Array.from(element.querySelectorAll('a'));

      for (const anchor of anchors) {
        const label = cleanValue(anchor.textContent);
        const url = anchor.href;

        if (label && url) {
          links.push({ label, url });
        }
      }
    }

    sibling = sibling.nextSibling;
  }

  return links.length > 0 ? links : undefined;
}

function extractMovieCreditsFromDocument(
  document: Document,
): readonly { title: string; year: number; distributor: string; notes?: string }[] | undefined {
  const rows = Array.from(document.querySelectorAll('#personal tbody tr'));

  type RawCredit = {
    title?: string;
    year: number;
    distributor: string;
    notes?: string;
  };

  const credits = rows
    .map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      return {
        title: cleanValue(cells[0]?.textContent),
        year: Number(cleanValue(cells[1]?.textContent)),
        distributor: cleanValue(cells[2]?.textContent) ?? '',
        notes: cleanValue(cells[3]?.textContent),
      } as RawCredit;
    })
    .filter(
      (credit): credit is { title: string; year: number; distributor: string; notes?: string } =>
        Boolean(credit.title) && Number.isFinite(credit.year),
    );

  return credits.length > 0 ? credits : undefined;
}

function cleanMultilineValue(value: string): string | undefined {
  const lines = value
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  return lines.length > 0 ? lines.join('\n') : undefined;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function splitLines(value: string | undefined): readonly string[] | undefined {
  if (!value) {
    return undefined;
  }

  const lines = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  return lines.length > 0 ? lines : undefined;
}

function removeParentheticalAge(birthday: string | undefined): string | undefined {
  return cleanValue(birthday?.replace(/\s*\(\d+ years old\)/i, ''));
}

function extractAgeStarted(yearsActive: string | undefined): number | undefined {
  const match = yearsActive?.match(/Started around (\d+) years old/i);

  return match ? Number(match[1]) : undefined;
}

function cleanValue(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function isIafdProfilePage(html: string): boolean {
  return (
    html.includes('<link rel="canonical" href="https://www.iafd.com/person.rme/') ||
    (html.includes('id="headshot"') && html.includes('Performer Credits'))
  );
}

function removeEmptyValues<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return entryValue.length > 0;
      }

      return entryValue !== undefined && entryValue !== '';
    }),
  ) as T;
}
