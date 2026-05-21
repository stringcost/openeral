#!/bin/bash
# Comprehensive FUSE mount integration test for openeral
# Runs inside the Docker dev container with PostgreSQL available
set -uo pipefail
# Note: we intentionally do NOT use 'set -e' because individual test assertions
# may fail without stopping the whole suite

PASS=0
FAIL=0
ERRORS=""

pass() {
    PASS=$((PASS + 1))
    echo "  PASS: $1"
}

fail() {
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $1"
    echo "  FAIL: $1"
}

assert_eq() {
    local actual="$1"
    local expected="$2"
    local msg="$3"
    if [ "$actual" = "$expected" ]; then
        pass "$msg"
    else
        fail "$msg (expected '$expected', got '$actual')"
    fi
}

assert_contains() {
    local haystack="$1"
    local needle="$2"
    local msg="$3"
    if echo "$haystack" | grep -qF "$needle"; then
        pass "$msg"
    else
        fail "$msg (expected to contain '$needle')"
    fi
}

assert_not_contains() {
    local haystack="$1"
    local needle="$2"
    local msg="$3"
    if echo "$haystack" | grep -qF "$needle"; then
        fail "$msg (should NOT contain '$needle')"
    else
        pass "$msg"
    fi
}

assert_path_exists() {
    local path="$1"
    local msg="$2"
    if [ -e "$path" ]; then
        pass "$msg"
    else
        fail "$msg (path '$path' does not exist)"
    fi
}

assert_is_dir() {
    local path="$1"
    local msg="$2"
    if [ -d "$path" ]; then
        pass "$msg"
    else
        fail "$msg ('$path' is not a directory)"
    fi
}

assert_is_file() {
    local path="$1"
    local msg="$2"
    if [ -f "$path" ]; then
        pass "$msg"
    else
        fail "$msg ('$path' is not a regular file)"
    fi
}

# Issue #7: open() returns ENOENT for nonexistent rows
assert_enoent() {
    local path="$1"
    local msg="$2"
    if cat "$path" 2>/dev/null; then
        fail "$msg (expected ENOENT but got content)"
    else
        pass "$msg"
    fi
}

MNT="${OPENERAL_TEST_MNT:-/mnt/pgtest}"
DB_CONN="${DB_CONN:-host=postgres user=pgmount password=pgmount dbname=testdb}"
DB_HOST="${DB_HOST:-$(echo "$DB_CONN" | grep -oP 'host=\K\S+')}"

# Find the openeral binary: explicit env var > cargo target relative to script > /workspace fallback
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENERAL_BIN="${OPENERAL_BIN:-$PROJECT_ROOT/target/debug/openeral}"
OPENERAL_HELPER_LINK="/usr/local/bin/openeral"
OPENERAL_HELPER_BACKUP=""
OPENERAL_HELPER_CREATED=0
SUDO=()
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO=(sudo -n)
fi

# Issue #11: reliable cleanup via trap
cleanup() {
    echo ""
    echo "--- Cleanup ---"
    fusermount -u "$MNT" 2>/dev/null || true
    fusermount -u /tmp/openeral_fuse3_test 2>/dev/null || true
    fusermount -u /tmp/openeral_fuse3_ws_test 2>/dev/null || true
    fusermount -u /tmp/openeral_fuse3_consistency 2>/dev/null || true
    if [ "$OPENERAL_HELPER_CREATED" -eq 1 ]; then
        "${SUDO[@]}" rm -f "$OPENERAL_HELPER_LINK"
        if [ -n "$OPENERAL_HELPER_BACKUP" ] && [ -e "$OPENERAL_HELPER_BACKUP" ]; then
            "${SUDO[@]}" mv "$OPENERAL_HELPER_BACKUP" "$OPENERAL_HELPER_LINK"
        fi
    fi
    if [ -n "${MOUNT_PID:-}" ]; then
        wait "$MOUNT_PID" 2>/dev/null || true
    fi
    echo "Unmounted"
}
trap cleanup EXIT

echo "=== openeral FUSE Integration Tests ==="
echo ""

# ---- Setup ----
echo "--- Setup ---"

if [ ! -e /dev/fuse ]; then
    echo "FATAL: /dev/fuse is not available in this test container."
    echo "Run act from this repository so .actrc starts the job container with FUSE privileges."
    exit 1
fi

DB_PORT="$(echo "$DB_CONN" | grep -oP '(^|[[:space:]])port=\K[^[:space:]]+' || true)"
if [ -n "$DB_PORT" ]; then
    export PGPORT="$DB_PORT"
fi

if ! grep -Eq '^[[:space:]]*user_allow_other([[:space:]]|$)' /etc/fuse.conf 2>/dev/null; then
    if [ "$(id -u)" -eq 0 ]; then
        sed -i 's/#user_allow_other/user_allow_other/' /etc/fuse.conf 2>/dev/null || true
        grep -Eq '^[[:space:]]*user_allow_other([[:space:]]|$)' /etc/fuse.conf 2>/dev/null ||
            printf '\nuser_allow_other\n' >>/etc/fuse.conf
    elif [ "${#SUDO[@]}" -gt 0 ]; then
        "${SUDO[@]}" sh -c "sed -i 's/#user_allow_other/user_allow_other/' /etc/fuse.conf 2>/dev/null || true; grep -Eq '^[[:space:]]*user_allow_other([[:space:]]|$)' /etc/fuse.conf 2>/dev/null || printf '\\nuser_allow_other\\n' >>/etc/fuse.conf"
    fi
fi

# Create test schema and tables
export PGPASSWORD=pgmount
if ! psql -h "$DB_HOST" -U pgmount -d testdb -q <<'SQL'
-- Clean slate
DROP SCHEMA IF EXISTS test_schema CASCADE;
CREATE SCHEMA test_schema;

-- Main test table with various types
CREATE TABLE test_schema.products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10,2),
    in_stock BOOLEAN DEFAULT true,
    category TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    description TEXT
);

INSERT INTO test_schema.products (name, price, in_stock, category, description) VALUES
    ('Widget A', 9.99, true, 'widgets', 'A basic widget'),
    ('Widget B', 19.99, true, 'widgets', 'A premium widget'),
    ('Gadget X', 49.99, false, 'gadgets', 'An advanced gadget'),
    ('Gadget Y', 99.99, true, 'gadgets', 'A luxury gadget'),
    ('Tool Z', 5.50, true, 'tools', NULL);

-- Table with composite primary key
CREATE TABLE test_schema.order_items (
    order_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price NUMERIC(10,2),
    PRIMARY KEY (order_id, item_id)
);

INSERT INTO test_schema.order_items (order_id, item_id, quantity, unit_price) VALUES
    (1, 1, 2, 9.99),
    (1, 2, 1, 19.99),
    (2, 1, 5, 9.99),
    (2, 3, 1, 49.99);

-- Table with NULL values
CREATE TABLE test_schema.nullable_test (
    id SERIAL PRIMARY KEY,
    required_field TEXT NOT NULL,
    optional_field TEXT
);

INSERT INTO test_schema.nullable_test (required_field, optional_field) VALUES
    ('has_value', 'present'),
    ('null_value', NULL);

-- Empty table
CREATE TABLE test_schema.empty_table (
    id SERIAL PRIMARY KEY,
    data TEXT
);

-- Table with special characters in names
CREATE TABLE test_schema."table with spaces" (
    id SERIAL PRIMARY KEY,
    "column with spaces" TEXT
);
INSERT INTO test_schema."table with spaces" ("column with spaces") VALUES ('hello world');

-- Create an index for testing
CREATE INDEX idx_products_category ON test_schema.products(category);
CREATE UNIQUE INDEX idx_products_name ON test_schema.products(name);

-- Make sure public schema also has test data
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.posts CASCADE;
CREATE TABLE public.users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    age INTEGER,
    active BOOLEAN DEFAULT true
);
INSERT INTO public.users (name, email, age, active) VALUES
    ('Alice', 'alice@example.com', 30, true),
    ('Bob', 'bob@example.com', 25, false),
    ('Charlie', 'charlie@example.com', 35, true);

-- Run ANALYZE for stats
ANALYZE;
SQL
then
    echo "Failed to create test data in PostgreSQL"
    exit 1
fi
echo "Test data created"

# Build openeral
echo "Building openeral..."
(cd "$PROJECT_ROOT" && cargo build 2>&1 | tail -1)

if [ ! -x "$OPENERAL_BIN" ]; then
    echo "Built openeral binary not found at $OPENERAL_BIN"
    exit 1
fi

OPENERAL_BIN_DIR="$(dirname "$OPENERAL_BIN")"
case ":$PATH:" in
    *":$OPENERAL_BIN_DIR:"*) ;;
    *) export PATH="$OPENERAL_BIN_DIR:$PATH" ;;
esac

# mount.fuse3 resolves the filesystem helper from a standard system PATH,
# not from this script's injected PATH. Install a temporary symlink so the
# helper uses the exact binary that was just built for the test.
if [ -e "$OPENERAL_HELPER_LINK" ] || [ -L "$OPENERAL_HELPER_LINK" ]; then
    OPENERAL_HELPER_BACKUP="${OPENERAL_HELPER_LINK}.bak.$$"
    if "${SUDO[@]}" mv "$OPENERAL_HELPER_LINK" "$OPENERAL_HELPER_BACKUP"; then
        OPENERAL_HELPER_CREATED=1
    else
        echo "Warning: could not back up $OPENERAL_HELPER_LINK; relying on PATH for mount.fuse3"
        OPENERAL_HELPER_BACKUP=""
    fi
fi
if "${SUDO[@]}" ln -s "$OPENERAL_BIN" "$OPENERAL_HELPER_LINK"; then
    OPENERAL_HELPER_CREATED=1
else
    echo "Warning: could not install $OPENERAL_HELPER_LINK; relying on PATH for mount.fuse3"
fi

# Create mount point and mount
mkdir -p "$MNT"
fusermount -u "$MNT" 2>/dev/null || true
sleep 0.5

echo "Mounting filesystem..."
RUST_LOG=warn "$OPENERAL_BIN" mount -c "$DB_CONN" "$MNT" &
MOUNT_PID=$!

# Verify mount succeeded
MOUNT_READY=0
for _ in $(seq 1 50); do
    if ! kill -0 "$MOUNT_PID" 2>/dev/null; then
        wait "$MOUNT_PID" 2>/dev/null || true
        echo "FATAL: Mount process exited before $MNT became a mount point"
        exit 1
    fi
    if mountpoint -q "$MNT" 2>/dev/null; then
        MOUNT_READY=1
        break
    fi
    sleep 0.2
done

if [ "$MOUNT_READY" -ne 1 ]; then
    echo "FATAL: Mount failed!"
    exit 1
fi
echo "Mount successful (PID=$MOUNT_PID)"
echo ""

# ========================================
# TEST SUITE
# ========================================

echo "--- 1. Root Directory (Schema Listing) ---"
ROOT_LS=$(ls "$MNT")
assert_contains "$ROOT_LS" "public" "Root lists 'public' schema"
assert_contains "$ROOT_LS" "test_schema" "Root lists 'test_schema' schema"
assert_not_contains "$ROOT_LS" "pg_catalog" "Root excludes 'pg_catalog'"
assert_not_contains "$ROOT_LS" "information_schema" "Root excludes 'information_schema'"
assert_is_dir "$MNT/public" "public is a directory"
assert_is_dir "$MNT/test_schema" "test_schema is a directory"
echo ""

echo "--- 2. Schema Directory (Table Listing) ---"
SCHEMA_LS=$(ls "$MNT/public")
assert_contains "$SCHEMA_LS" "users" "public schema lists 'users'"

TS_LS=$(ls "$MNT/test_schema")
assert_contains "$TS_LS" "products" "test_schema lists 'products'"
assert_contains "$TS_LS" "order_items" "test_schema lists 'order_items'"
assert_contains "$TS_LS" "nullable_test" "test_schema lists 'nullable_test'"
assert_contains "$TS_LS" "empty_table" "test_schema lists 'empty_table'"
echo ""

echo "--- 3. Table Directory (Pagination + Special Dirs) ---"
# Table directories now contain page_N/ subdirectories instead of direct row dirs
TABLE_LS=$(ls -a "$MNT/test_schema/products")
assert_contains "$TABLE_LS" ".info" "Table has .info directory"
assert_contains "$TABLE_LS" ".export" "Table has .export directory"
assert_contains "$TABLE_LS" ".filter" "Table has .filter directory"
assert_contains "$TABLE_LS" ".order" "Table has .order directory"
assert_contains "$TABLE_LS" ".indexes" "Table has .indexes directory"
assert_contains "$TABLE_LS" "page_1" "Table has page_1 subdirectory"
# Row directories are NOT directly under the table anymore
assert_not_contains "$(ls "$MNT/test_schema/products")" "^1$" "Table does NOT list row '1' directly"
assert_is_dir "$MNT/test_schema/products/page_1" "page_1 is a directory"
assert_is_dir "$MNT/test_schema/products/.info" ".info is a directory"
echo ""

echo "--- 3b. Page Directory (Row Listing) ---"
# Rows live inside page_N/ directories
PAGE_LS=$(ls "$MNT/test_schema/products/page_1")
assert_contains "$PAGE_LS" "1" "page_1 has row '1'"
assert_contains "$PAGE_LS" "5" "page_1 has row '5'"
assert_is_dir "$MNT/test_schema/products/page_1/1" "Row 1 inside page_1 is a directory"
echo ""

echo "--- 4. Row Directory (Columns + Format Files) ---"
# Rows are now accessed via page_N/row_pk path
ROW_LS=$(ls "$MNT/test_schema/products/page_1/1")
assert_contains "$ROW_LS" "id" "Row has 'id' column"
assert_contains "$ROW_LS" "name" "Row has 'name' column"
assert_contains "$ROW_LS" "price" "Row has 'price' column"
assert_contains "$ROW_LS" "in_stock" "Row has 'in_stock' column"
assert_contains "$ROW_LS" "category" "Row has 'category' column"
assert_contains "$ROW_LS" "description" "Row has 'description' column"
assert_contains "$ROW_LS" "row.json" "Row has 'row.json'"
assert_contains "$ROW_LS" "row.csv" "Row has 'row.csv'"
assert_contains "$ROW_LS" "row.yaml" "Row has 'row.yaml'"
assert_is_file "$MNT/test_schema/products/page_1/1/name" "Column 'name' is a file"
assert_is_file "$MNT/test_schema/products/page_1/1/row.json" "row.json is a file"
echo ""

echo "--- 5. Column Value Reading ---"
VAL_NAME=$(cat "$MNT/test_schema/products/page_1/1/name")
assert_eq "$VAL_NAME" "Widget A" "Column value: name = 'Widget A'"

VAL_PRICE=$(cat "$MNT/test_schema/products/page_1/1/price")
assert_eq "$VAL_PRICE" "9.99" "Column value: price = '9.99'"

VAL_STOCK=$(cat "$MNT/test_schema/products/page_1/1/in_stock")
assert_eq "$VAL_STOCK" "true" "Column value: in_stock = 'true'"

VAL_CAT=$(cat "$MNT/test_schema/products/page_1/1/category")
assert_eq "$VAL_CAT" "widgets" "Column value: category = 'widgets'"

# Test different row
VAL_NAME3=$(cat "$MNT/test_schema/products/page_1/3/name")
assert_eq "$VAL_NAME3" "Gadget X" "Row 3 name = 'Gadget X'"

VAL_STOCK3=$(cat "$MNT/test_schema/products/page_1/3/in_stock")
assert_eq "$VAL_STOCK3" "false" "Row 3 in_stock = 'false'"

# Test NULL value
VAL_NULL=$(cat "$MNT/test_schema/nullable_test/page_1/2/optional_field")
assert_eq "$VAL_NULL" "NULL" "NULL column reads as 'NULL'"

VAL_NOTNULL=$(cat "$MNT/test_schema/nullable_test/page_1/1/optional_field")
assert_eq "$VAL_NOTNULL" "present" "Non-null optional field reads correctly"
echo ""

echo "--- 6. Row Format Files ---"
# JSON
ROW_JSON=$(cat "$MNT/test_schema/products/page_1/1/row.json")
assert_contains "$ROW_JSON" '"name"' "row.json contains column name"
assert_contains "$ROW_JSON" '"Widget A"' "row.json contains value"
# Verify it's valid JSON
if echo "$ROW_JSON" | python3 -m json.tool >/dev/null 2>&1; then
    pass "row.json is valid JSON"
else
    fail "row.json is NOT valid JSON"
fi

# CSV
ROW_CSV=$(cat "$MNT/test_schema/products/page_1/1/row.csv")
assert_contains "$ROW_CSV" "name" "row.csv contains header"
assert_contains "$ROW_CSV" "Widget A" "row.csv contains value"

# YAML
ROW_YAML=$(cat "$MNT/test_schema/products/page_1/1/row.yaml")
assert_contains "$ROW_YAML" "name:" "row.yaml contains column"
assert_contains "$ROW_YAML" "Widget A" "row.yaml contains value"
echo ""

echo "--- 7. .info/ Directory ---"
INFO_LS=$(ls "$MNT/test_schema/products/.info")
assert_contains "$INFO_LS" "columns.json" ".info has columns.json"
assert_contains "$INFO_LS" "schema.sql" ".info has schema.sql"
assert_contains "$INFO_LS" "count" ".info has count"
assert_contains "$INFO_LS" "primary_key" ".info has primary_key"

# columns.json
COLS_JSON=$(cat "$MNT/test_schema/products/.info/columns.json")
assert_contains "$COLS_JSON" '"name"' "columns.json has name field"
assert_contains "$COLS_JSON" '"data_type"' "columns.json has data_type field"
if echo "$COLS_JSON" | python3 -m json.tool >/dev/null 2>&1; then
    pass "columns.json is valid JSON"
else
    fail "columns.json is NOT valid JSON"
fi

# schema.sql
SCHEMA_SQL=$(cat "$MNT/test_schema/products/.info/schema.sql")
assert_contains "$SCHEMA_SQL" "CREATE TABLE" "schema.sql contains CREATE TABLE"
assert_contains "$SCHEMA_SQL" "name" "schema.sql contains column 'name'"
assert_contains "$SCHEMA_SQL" "PRIMARY KEY" "schema.sql contains PRIMARY KEY"

# count
COUNT=$(cat "$MNT/test_schema/products/.info/count")
assert_eq "$COUNT" "5" "count returns 5 for products"

# primary_key
PK=$(cat "$MNT/test_schema/products/.info/primary_key")
assert_eq "$PK" "id" "primary_key returns 'id'"

# Test empty table count
EMPTY_COUNT=$(cat "$MNT/test_schema/empty_table/.info/count")
assert_eq "$EMPTY_COUNT" "0" "empty table count = 0"
echo ""

echo "--- 8. .export/ Directory (Paginated Exports) ---"
EXPORT_LS=$(ls "$MNT/test_schema/products/.export")
assert_contains "$EXPORT_LS" "data.json" ".export has data.json"
assert_contains "$EXPORT_LS" "data.csv" ".export has data.csv"
assert_contains "$EXPORT_LS" "data.yaml" ".export has data.yaml"

# data.json is now a DIRECTORY containing page_N.json files
assert_is_dir "$MNT/test_schema/products/.export/data.json" "data.json is a directory (paginated)"
EXPORT_JSON_LS=$(ls "$MNT/test_schema/products/.export/data.json")
assert_contains "$EXPORT_JSON_LS" "page_1.json" "data.json/ has page_1.json"

# Read paginated export
EXPORT_JSON=$(cat "$MNT/test_schema/products/.export/data.json/page_1.json")
if echo "$EXPORT_JSON" | python3 -m json.tool >/dev/null 2>&1; then
    pass "export data.json/page_1.json is valid JSON"
else
    fail "export data.json/page_1.json is NOT valid JSON"
fi
assert_contains "$EXPORT_JSON" "Widget A" "export data.json/page_1.json contains Widget A"
assert_contains "$EXPORT_JSON" "Gadget X" "export data.json/page_1.json contains Gadget X"
assert_contains "$EXPORT_JSON" "Tool Z" "export data.json/page_1.json contains Tool Z"

# data.csv is now a DIRECTORY containing page_N.csv files
assert_is_dir "$MNT/test_schema/products/.export/data.csv" "data.csv is a directory (paginated)"
EXPORT_CSV_LS=$(ls "$MNT/test_schema/products/.export/data.csv")
assert_contains "$EXPORT_CSV_LS" "page_1.csv" "data.csv/ has page_1.csv"

EXPORT_CSV=$(cat "$MNT/test_schema/products/.export/data.csv/page_1.csv")
CSV_LINES=$(echo "$EXPORT_CSV" | wc -l)
# Should have header + 5 rows = 6 lines
if [ "$CSV_LINES" -ge 6 ]; then
    pass "export data.csv/page_1.csv has >= 6 lines (header + 5 rows)"
else
    fail "export data.csv/page_1.csv has $CSV_LINES lines, expected >= 6"
fi

# data.yaml is now a DIRECTORY containing page_N.yaml files
assert_is_dir "$MNT/test_schema/products/.export/data.yaml" "data.yaml is a directory (paginated)"
EXPORT_YAML_LS=$(ls "$MNT/test_schema/products/.export/data.yaml")
assert_contains "$EXPORT_YAML_LS" "page_1.yaml" "data.yaml/ has page_1.yaml"

EXPORT_YAML=$(cat "$MNT/test_schema/products/.export/data.yaml/page_1.yaml")
assert_contains "$EXPORT_YAML" "Widget A" "export data.yaml/page_1.yaml contains Widget A"
echo ""

echo "--- 9. .indexes/ Directory ---"
IDX_LS=$(ls "$MNT/test_schema/products/.indexes")
assert_contains "$IDX_LS" "idx_products_category" ".indexes lists idx_products_category"
assert_contains "$IDX_LS" "idx_products_name" ".indexes lists idx_products_name"

# Read an index file
IDX_CONTENT=$(cat "$MNT/test_schema/products/.indexes/idx_products_name")
assert_contains "$IDX_CONTENT" "Unique: true" "idx_products_name shows Unique: true"
assert_contains "$IDX_CONTENT" "name" "idx_products_name shows column name"
assert_contains "$IDX_CONTENT" "Definition:" "idx_products_name has Definition"

IDX_CAT=$(cat "$MNT/test_schema/products/.indexes/idx_products_category")
assert_contains "$IDX_CAT" "Unique: false" "idx_products_category shows Unique: false"
echo ""

echo "--- 10. .filter/ Pipeline ---"
FILTER_LS=$(ls "$MNT/test_schema/products/.filter")
assert_contains "$FILTER_LS" "category" ".filter lists 'category' column"
assert_contains "$FILTER_LS" "name" ".filter lists 'name' column"
assert_contains "$FILTER_LS" "in_stock" ".filter lists 'in_stock' column"

# Navigate into filter: .filter/category/widgets/
# Filter/order results show rows directly (no pagination)
assert_is_dir "$MNT/test_schema/products/.filter/category" ".filter/category is a directory"

FILTERED=$(ls "$MNT/test_schema/products/.filter/category/widgets")
assert_contains "$FILTERED" "1" "filter widgets contains row 1"
assert_contains "$FILTERED" "2" "filter widgets contains row 2"
# Should NOT contain rows 3,4,5 (gadgets/tools)
assert_not_contains "$FILTERED" "3" "filter widgets does not contain row 3"
assert_not_contains "$FILTERED" "4" "filter widgets does not contain row 4"

# Verify filtered row data is correct
FILTERED_NAME=$(cat "$MNT/test_schema/products/.filter/category/widgets/1/name" 2>/dev/null || echo "ERROR")
assert_eq "$FILTERED_NAME" "Widget A" "Filtered row 1 name = 'Widget A'"

# Filter by boolean
FILTERED_STOCK=$(ls "$MNT/test_schema/products/.filter/in_stock/false")
assert_contains "$FILTERED_STOCK" "3" "filter in_stock=false contains row 3 (Gadget X)"
assert_not_contains "$FILTERED_STOCK" "1" "filter in_stock=false does not contain row 1"
echo ""

echo "--- 11. .order/ Pipeline ---"
ORDER_LS=$(ls "$MNT/test_schema/products/.order")
assert_contains "$ORDER_LS" "name" ".order lists 'name' column"
assert_contains "$ORDER_LS" "price" ".order lists 'price' column"

# Navigate: .order/name/
ORDER_NAME=$(ls "$MNT/test_schema/products/.order/name")
assert_contains "$ORDER_NAME" "asc" ".order/name has 'asc'"
assert_contains "$ORDER_NAME" "desc" ".order/name has 'desc'"

# Verify ordered rows exist — all 5 should appear
# Filter/order results show rows directly (no pagination)
ORDERED_ASC=$(ls "$MNT/test_schema/products/.order/name/asc")
ORDERED_ASC_COUNT=$(echo "$ORDERED_ASC" | wc -l)
if [ "$ORDERED_ASC_COUNT" -eq 5 ]; then
    pass "order/name/asc has 5 rows"
else
    fail "order/name/asc has $ORDERED_ASC_COUNT rows, expected 5"
fi

# Verify we can access row data through ordered view
# Row 3 is Gadget X — verify we can read its name through the ordered dir
ORDERED_ROW_NAME=$(cat "$MNT/test_schema/products/.order/name/asc/3/name" 2>/dev/null || echo "ERROR")
assert_eq "$ORDERED_ROW_NAME" "Gadget X" "Can read row data through .order/name/asc"

ORDERED_DESC=$(ls "$MNT/test_schema/products/.order/name/desc")
ORDERED_DESC_COUNT=$(echo "$ORDERED_DESC" | wc -l)
if [ "$ORDERED_DESC_COUNT" -eq 5 ]; then
    pass "order/name/desc has 5 rows"
else
    fail "order/name/desc has $ORDERED_DESC_COUNT rows, expected 5"
fi
echo ""

echo "--- 12. Composite Primary Key (Percent-Encoded) ---"
# Composite PKs use percent-encoding; for integer keys no special chars to encode
# so the format stays order_id=1,item_id=1
COMP_LS=$(ls "$MNT/test_schema/order_items/page_1")
assert_contains "$COMP_LS" "order_id=1,item_id=1" "Composite PK: order_id=1,item_id=1"
assert_contains "$COMP_LS" "order_id=1,item_id=2" "Composite PK: order_id=1,item_id=2"
assert_contains "$COMP_LS" "order_id=2,item_id=1" "Composite PK: order_id=2,item_id=1"

# Read composite PK row (via page_1)
COMP_QTY=$(cat "$MNT/test_schema/order_items/page_1/order_id=1,item_id=1/quantity")
assert_eq "$COMP_QTY" "2" "Composite PK row: quantity = 2"

COMP_PRICE=$(cat "$MNT/test_schema/order_items/page_1/order_id=2,item_id=3/unit_price")
assert_eq "$COMP_PRICE" "49.99" "Composite PK row: unit_price = 49.99"
echo ""

echo "--- 13. Empty Table ---"
EMPTY_LS=$(ls -a "$MNT/test_schema/empty_table")
# Should have special dirs but no page dirs (no rows)
assert_contains "$EMPTY_LS" ".info" "Empty table has .info"
# ls output for empty table should be just special dirs (no page_N entries)
EMPTY_PAGE_COUNT=$(ls "$MNT/test_schema/empty_table" 2>/dev/null | grep -c '^page_' || true)
assert_eq "$EMPTY_PAGE_COUNT" "0" "Empty table has 0 page directories"
echo ""

echo "--- 14. Multiple Schema Browsing ---"
# Verify we can browse across schemas (via page_1 for row access)
PUB_USER_NAME=$(cat "$MNT/public/users/page_1/1/name")
assert_eq "$PUB_USER_NAME" "Alice" "public.users row 1 name = 'Alice'"

TS_PROD_NAME=$(cat "$MNT/test_schema/products/page_1/1/name")
assert_eq "$TS_PROD_NAME" "Widget A" "test_schema.products row 1 name = 'Widget A'"
echo ""

echo "--- 15. NULL Description Column ---"
# Tool Z (row 5) has NULL description
NULL_DESC=$(cat "$MNT/test_schema/products/page_1/5/description")
assert_eq "$NULL_DESC" "NULL" "Row 5 NULL description reads as 'NULL'"

NOTNULL_DESC=$(cat "$MNT/test_schema/products/page_1/1/description")
assert_eq "$NOTNULL_DESC" "A basic widget" "Row 1 description = 'A basic widget'"
echo ""

echo "--- 16. Table with Spaces in Names ---"
# This tests quote_ident handling
if ls "$MNT/test_schema/table with spaces" >/dev/null 2>&1; then
    pass "Can access table with spaces in name"
    SPACE_VAL=$(cat "$MNT/test_schema/table with spaces/page_1/1/column with spaces" 2>/dev/null || echo "ERROR")
    assert_eq "$SPACE_VAL" "hello world" "Read column with spaces = 'hello world'"
else
    fail "Cannot access table with spaces in name"
fi
echo ""

echo "--- 17. Nonexistent Row Returns ENOENT (Issue #7) ---"
# open() now returns ENOENT for nonexistent rows, not empty content
assert_enoent "$MNT/test_schema/products/page_1/9999/name" "Nonexistent row 9999 returns ENOENT"
assert_enoent "$MNT/test_schema/products/page_1/0/name" "Nonexistent row 0 returns ENOENT"
echo ""

echo "--- 18. Percent-Encoding of PK Values ---"
# For integer PKs, no special chars to encode — directory names are plain numbers
# Verify normal integer PKs still work through page directories
assert_is_dir "$MNT/test_schema/products/page_1/1" "Integer PK '1' accessible in page_1"
assert_is_dir "$MNT/test_schema/products/page_1/5" "Integer PK '5' accessible in page_1"
# Composite integer PKs also have no special chars to encode
assert_is_dir "$MNT/test_schema/order_items/page_1/order_id=1,item_id=1" "Composite integer PK accessible in page_1"
echo ""

# ---- mount.fuse3 Integration Tests ----

# `allow_other` requires an explicit host opt-in via /etc/fuse.conf.
# CI enables this ahead of the test run; local development often does not.
FUSE3_ALLOW_OTHER_OPT=""
if grep -Eq '^[[:space:]]*user_allow_other([[:space:]]|$)' /etc/fuse.conf 2>/dev/null; then
    FUSE3_ALLOW_OTHER_OPT=",allow_other"
fi

if [ -z "$FUSE3_ALLOW_OTHER_OPT" ]; then
    echo "--- 19. mount.fuse3 Database Mount ---"
    echo "  SKIP: /etc/fuse.conf does not enable user_allow_other"
    echo ""
    echo "--- 20. mount.fuse3 Workspace Mount ---"
    echo "  SKIP: /etc/fuse.conf does not enable user_allow_other"
    echo ""
    echo "--- 21. Migration Compatibility Tables ---"
    echo "  SKIP: /etc/fuse.conf does not enable user_allow_other"
    echo ""
    echo "--- 22. Consistency: Direct vs mount.fuse3 ---"
    echo "  SKIP: /etc/fuse.conf does not enable user_allow_other"
    echo ""
else
echo "--- 19. mount.fuse3 Database Mount ---"
FUSE3_MNT="/tmp/openeral_fuse3_test"
mkdir -p "$FUSE3_MNT"

# mount.fuse3 replaces its process with the FUSE daemon, so mount blocks.
# Run in background, wait for mountpoint to appear.
mount -t fuse.openeral "$DB_CONN" "$FUSE3_MNT" -o "ro${FUSE3_ALLOW_OTHER_OPT}" &
FUSE3_PID=$!

fuse3_ready=0
for i in $(seq 1 10); do
    if mountpoint -q "$FUSE3_MNT" 2>/dev/null; then
        fuse3_ready=1
        break
    fi
    sleep 1
done

if [ "$fuse3_ready" -eq 1 ]; then
    pass "mount.fuse3 database mount succeeded"

    fuse3_schemas=$(ls "$FUSE3_MNT/" 2>/dev/null)
    assert_contains "$fuse3_schemas" "public" "mount.fuse3: lists public schema"
    assert_contains "$fuse3_schemas" "test_schema" "mount.fuse3: lists test_schema"

    fuse3_name=$(cat "$FUSE3_MNT/test_schema/products/page_1/1/name" 2>/dev/null)
    assert_eq "$fuse3_name" "Widget A" "mount.fuse3: read column value"

    fuse3_json=$(cat "$FUSE3_MNT/test_schema/products/page_1/1/row.json" 2>/dev/null)
    assert_contains "$fuse3_json" "Widget A" "mount.fuse3: row.json contains expected data"

    fusermount -u "$FUSE3_MNT" 2>/dev/null
    wait "$FUSE3_PID" 2>/dev/null || true
    pass "mount.fuse3 database unmount succeeded"
else
    fail "mount.fuse3 database mount failed (not ready after 10s)"
    kill "$FUSE3_PID" 2>/dev/null || true
fi
rmdir "$FUSE3_MNT" 2>/dev/null
echo ""

echo "--- 20. mount.fuse3 Workspace Mount ---"
FUSE3_WS_MNT="/tmp/openeral_fuse3_ws_test"
mkdir -p "$FUSE3_WS_MNT"

OPENERAL_DATABASE_URL="$DB_CONN" \
    "$OPENERAL_BIN" workspace create fuse3-test --display-name "fuse3 test" --skip-migrations 2>/dev/null || true

mount -t fuse.openeral \
    "${DB_CONN}#workspace#fuse3-test" \
    "$FUSE3_WS_MNT" -o "rw${FUSE3_ALLOW_OTHER_OPT}" &
FUSE3_WS_PID=$!

fuse3_ws_ready=0
for i in $(seq 1 10); do
    if mountpoint -q "$FUSE3_WS_MNT" 2>/dev/null; then
        fuse3_ws_ready=1
        break
    fi
    sleep 1
done

if [ "$fuse3_ws_ready" -eq 1 ]; then
    pass "mount.fuse3 workspace mount succeeded"

    echo "fuse3 workspace test" > "$FUSE3_WS_MNT/fuse3_test.txt" 2>/dev/null
    fuse3_ws_content=$(cat "$FUSE3_WS_MNT/fuse3_test.txt" 2>/dev/null)
    assert_eq "$fuse3_ws_content" "fuse3 workspace test" "mount.fuse3: workspace write+read"

    mkdir -p "$FUSE3_WS_MNT/.claude" 2>/dev/null
    fuse3_long_json='{"openeralSmoke":{"runId":"long"},"padding":"this suffix must disappear after a shorter rewrite"}'
    fuse3_short_json='{"openeralSmoke":{"runId":"short"}}'
    printf '%s' "$fuse3_long_json" > "$FUSE3_WS_MNT/.claude/.claude.json" 2>/dev/null
    printf '%s' "$fuse3_short_json" > "$FUSE3_WS_MNT/.claude/.claude.json" 2>/dev/null
    fuse3_truncated_content=$(cat "$FUSE3_WS_MNT/.claude/.claude.json" 2>/dev/null)
    assert_eq "$fuse3_truncated_content" "$fuse3_short_json" "mount.fuse3: shorter rewrite drops stale tail bytes"

    fuse3_truncated_row=$(psql "$DB_CONN" -Atqc \
        "SELECT size || '|' || octet_length(content) || '|' || convert_from(content, 'UTF8') FROM _openeral.workspace_files WHERE workspace_id = 'fuse3-test' AND path = '/.claude/.claude.json'" 2>/dev/null)
    assert_eq "$fuse3_truncated_row" "${#fuse3_short_json}|${#fuse3_short_json}|$fuse3_short_json" "mount.fuse3: shorter rewrite persists exact DB content"

    fuse3_atomic_old='{"openeralSmoke":{"version":"old"},"padding":"replace me"}'
    fuse3_atomic_new='{"openeralSmoke":{"version":"new"}}'
    printf '%s' "$fuse3_atomic_old" > "$FUSE3_WS_MNT/.claude/atomic.json" 2>/dev/null
    printf '%s' "$fuse3_atomic_new" > "$FUSE3_WS_MNT/.claude/atomic.json.tmp" 2>/dev/null
    mv "$FUSE3_WS_MNT/.claude/atomic.json.tmp" "$FUSE3_WS_MNT/.claude/atomic.json" 2>/dev/null
    fuse3_atomic_content=$(cat "$FUSE3_WS_MNT/.claude/atomic.json" 2>/dev/null)
    assert_eq "$fuse3_atomic_content" "$fuse3_atomic_new" "mount.fuse3: atomic rename replaces target content"

    fuse3_atomic_row=$(psql "$DB_CONN" -Atqc \
        "SELECT size || '|' || octet_length(content) || '|' || convert_from(content, 'UTF8') FROM _openeral.workspace_files WHERE workspace_id = 'fuse3-test' AND path = '/.claude/atomic.json'" 2>/dev/null)
    assert_eq "$fuse3_atomic_row" "${#fuse3_atomic_new}|${#fuse3_atomic_new}|$fuse3_atomic_new" "mount.fuse3: atomic rename persists exact DB content"

    if timeout 10s ls -la "$FUSE3_WS_MNT/.claude" >/dev/null 2>&1; then
        pass "mount.fuse3: Claude config directory ls completes"
    else
        fail "mount.fuse3: Claude config directory ls timed out"
    fi

    if timeout 10s find "$FUSE3_WS_MNT/.claude" -maxdepth 1 -type f >/dev/null 2>&1; then
        pass "mount.fuse3: Claude config directory find completes"
    else
        fail "mount.fuse3: Claude config directory find timed out"
    fi

    if mkdir "$FUSE3_WS_MNT/.ssh" 2>/dev/null; then
        fail "mount.fuse3: sensitive .ssh directory should be denied"
    else
        pass "mount.fuse3: sensitive .ssh directory denied"
    fi

    if printf secret > "$FUSE3_WS_MNT/.npmrc" 2>/dev/null; then
        fail "mount.fuse3: sensitive .npmrc file should be denied"
    else
        pass "mount.fuse3: sensitive .npmrc file denied"
    fi

    fusermount -u "$FUSE3_WS_MNT" 2>/dev/null
    wait "$FUSE3_WS_PID" 2>/dev/null || true
    pass "mount.fuse3 workspace unmount succeeded"
else
    fail "mount.fuse3 workspace mount failed (not ready after 10s)"
    kill "$FUSE3_WS_PID" 2>/dev/null || true
fi
rmdir "$FUSE3_WS_MNT" 2>/dev/null
echo ""

echo "--- 21. Migration Compatibility Tables ---"
OPT_TABLE_COUNT=$(PGPASSWORD=pgmount psql -h "$DB_HOST" -U pgmount -d testdb -Atqc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = '_openeral' AND table_name IN ('optimization_metrics', 'api_cache')" 2>/dev/null || echo "0")
assert_eq "$OPT_TABLE_COUNT" "2" "Optimization tables exist"
echo ""

echo "--- 22. Consistency: Direct vs mount.fuse3 ---"
FUSE3_CONS_MNT="/tmp/openeral_fuse3_consistency"
mkdir -p "$FUSE3_CONS_MNT"

mount -t fuse.openeral "$DB_CONN" "$FUSE3_CONS_MNT" -o "ro${FUSE3_ALLOW_OTHER_OPT}" &
FUSE3_CONS_PID=$!

fuse3_cons_ready=0
for i in $(seq 1 10); do
    if mountpoint -q "$FUSE3_CONS_MNT" 2>/dev/null; then
        fuse3_cons_ready=1
        break
    fi
    sleep 1
done

if [ "$fuse3_cons_ready" -eq 1 ]; then
    direct_schemas=$(ls "$MNT/" 2>/dev/null | sort)
    fuse3_schemas=$(ls "$FUSE3_CONS_MNT/" 2>/dev/null | sort)
    assert_eq "$direct_schemas" "$fuse3_schemas" "Consistency: schema listing matches"

    direct_tables=$(ls "$MNT/test_schema/" 2>/dev/null | sort)
    fuse3_tables=$(ls "$FUSE3_CONS_MNT/test_schema/" 2>/dev/null | sort)
    assert_eq "$direct_tables" "$fuse3_tables" "Consistency: table listing matches"

    direct_row=$(cat "$MNT/test_schema/products/page_1/1/row.json" 2>/dev/null)
    fuse3_row=$(cat "$FUSE3_CONS_MNT/test_schema/products/page_1/1/row.json" 2>/dev/null)
    assert_eq "$direct_row" "$fuse3_row" "Consistency: row.json content matches"

    fusermount -u "$FUSE3_CONS_MNT" 2>/dev/null
    wait "$FUSE3_CONS_PID" 2>/dev/null || true
    pass "Consistency test cleanup succeeded"
else
    fail "Consistency test: mount.fuse3 mount failed (not ready after 10s)"
    kill "$FUSE3_CONS_PID" 2>/dev/null || true
fi
rmdir "$FUSE3_CONS_MNT" 2>/dev/null
echo ""
fi

# ---- Summary ----
# (Cleanup happens via the EXIT trap handler — Issue #11)
echo ""
echo "========================================="
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "========================================="
if [ "$FAIL" -gt 0 ]; then
    echo -e "\nFailures:$ERRORS"
    exit 1
else
    echo "  All tests passed!"
    exit 0
fi
