# Third-party data

The generated graph data is based on **Russian Word Frequency Lists for Children** by Digital Pushkin Lab, compiled from DetCorpus.

- Source: https://github.com/Digital-Pushkin-Lab/Russian-Word-Frequency-Lists-for-Children
- License: CC0 1.0 Universal
- Fields used: lemma and normalized frequency (items per million, `ipm`)
- Transformation: the first 20,000 valid Cyrillic lemmas of length 2–14 were grouped by sorted-letter signature; graph edges were precomputed from signatures.

The Google Fonts loaded by the demo are Onest and Manrope. They are distributed under the SIL Open Font License.
