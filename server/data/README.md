# server/data/

## common-passwords.txt

Passwords the server refuses (ASVS 5.0.0 V6.2.4: check against at least the top 3,000 passwords that satisfy the
password policy). Bundled so the check works without internet access.

| | |
|---|---|
| Entries | 11,146 — one per line, lower-case, UTF-8, LF line endings |
| SHA-256 | `81ccfb5b7ff310a7f83156992c0ff1cc575494011ebde5b21679614812a7dc8e` |
| Built | 2026-10-27 |
| Rule | Every entry of 15–128 characters (the policy's length range) from the two sources below, in their frequency order, lower-cased, duplicates removed. 3 source lines with control characters or invalid UTF-8 were skipped. |

Sources (SecLists, MIT licence, fetched from `raw.githubusercontent.com/danielmiessler/SecLists/master/` on 2026-10-27):

| File | SHA-256 of the downloaded file |
|---|---|
| `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` | `424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51` |
| `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` | `c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0` |

The comparison is case-insensitive (`src/auth/passwordPolicy.ts`), which is why the entries are stored lower-case.
To rebuild or extend the list, record the new sources and hashes here in the same commit.

Licence of the source lists:

```
MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
