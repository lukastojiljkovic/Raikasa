#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Builds _site/ exactly as GitHub Pages will serve it. ci-site.yml checks the result,
# and pages.yml runs this same script in a job that runs no third-party code before it
# uploads the Pages artifact (engineering standard, section 3.4; R2-B3). Change the
# layout here only, so the checked site and the published site cannot drift apart.
set -euo pipefail

rm -rf _site
cp -r site _site
# "docs/images/." copies the folder's contents, so they merge into site/images when it exists too
# (a plain "cp -r docs/images _site/images" would nest them as _site/images/images).
if [ -d docs/images ]; then mkdir -p _site/images && cp -r docs/images/. _site/images/; fi
