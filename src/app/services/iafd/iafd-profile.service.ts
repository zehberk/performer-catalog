import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

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
        console.log(html);
        debugger;
        if (!isIafdProfilePage(html)) {
          throw new Error('The URL did not resolve to an IAFD performer profile page.');
        }

        return this.parseProfile(summary, iafdUrl, html);
      }),
    );
  }

  private fetchIafdDocument(iafdUrl: string): Observable<string> {
    return this.http
      .get(iafdUrl, { responseType: 'text' })
      .pipe(catchError(() => this.fetchViaReaderProxy(iafdUrl)));
  }

  private fetchViaReaderProxy(iafdUrl: string): Observable<string> {
    const proxyUrl = `https://r.jina.ai/http://${iafdUrl.replace(/^https?:\/\//, '')}`;

    return this.http
      .get(proxyUrl, { responseType: 'text' })
      .pipe(
        catchError(() =>
          throwError(
            () =>
              new Error(
                'Unable to load the IAFD page. Check the link and try again. If it keeps failing, the site may be blocking browser access.',
              ),
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
    content: string,
  ): PerformerProfile {
    const isMarkdown = isReaderProxyMarkdown(content);
    const document = isMarkdown ? undefined : new DOMParser().parseFromString(content, 'text/html');
    const bio = document ? collectBioFields(document) : collectBioFieldsFromMarkdown(content);
    const yearsActive = bio.get('years active');
    const name =
      (document
        ? cleanValue(document.querySelector('h1')?.textContent)
        : extractNameFromMarkdown(content)) ?? summary.name;

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
  if (isReaderProxyMarkdown(html)) {
    return /URL Source:\s*https?:\/\/(?:www\.)?iafd\.com\/person\.rme\//i.test(html);
  }

  return (
    html.includes('<link rel="canonical" href="https://www.iafd.com/person.rme/') ||
    (html.includes('id="headshot"') && html.includes('Performer Credits'))
  );
}

function isReaderProxyMarkdown(content: string): boolean {
  return content.includes('Markdown Content:') && content.includes('URL Source:');
}

function extractNameFromMarkdown(content: string): string | undefined {
  const headingMatch = content.match(/^#\s+(.+?)\s+-\s+iafd\.com\s*$/im);

  return cleanValue(headingMatch?.[1]);
}

function collectBioFieldsFromMarkdown(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  const markdown = content.split('Markdown Content:')[1] ?? content;
  const lines = markdown.split(/\r?\n/);
  let currentLabel: string | undefined;
  let currentValues: string[] = [];

  const flushField = (): void => {
    if (!currentLabel) {
      return;
    }

    const value = cleanMultilineValue(currentValues.join('\n'));

    if (value) {
      fields.set(currentLabel, value);
    }

    currentLabel = undefined;
    currentValues = [];
  };

  for (const line of lines) {
    const boldMatch = line.match(/^\*\*([^:*]+)\*\*\s*:?\s*(.*)$/);
    const plainMatch = line.match(/^([A-Za-z][A-Za-z ]{2,}):\s*(.*)$/);
    const match = boldMatch ?? plainMatch;

    if (match) {
      flushField();
      currentLabel = normalizeText(match[1]);
      const initialValue = cleanValue(match[2]);

      if (initialValue) {
        currentValues.push(initialValue);
      }

      continue;
    }

    if (!currentLabel) {
      continue;
    }

    const listItemValue = cleanValue(line.replace(/^\s*[*-]\s+/, ''));

    if (listItemValue) {
      currentValues.push(listItemValue);
      continue;
    }

    if (!line.trim()) {
      flushField();
    }
  }

  flushField();
  return fields;
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
