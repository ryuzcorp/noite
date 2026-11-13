### Fixed

- The new-pull-request page crashed (`Cannot read properties of undefined (reading 'length')`) whenever the picked base and head were a real pair: ilha keys an atom by its allocation order inside the fiber's render, and a compare resource created only once the picks differed shifted every later atom by one — the compare inherited the pull-request list's atom and the summary read `files` off that payload. The compare now lives in its own component keyed by the pair, so each pair gets its own resource and the form's own allocation sequence never changes.
