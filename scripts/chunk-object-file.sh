#!/bin/bash
set -e  # Exit on any error

# WAX IPFS Pinning - Object File Chunking Script
# ============================================
# This script breaks up the main object.json file into smaller chunks
# so each scheduled run processes a bounded subset and stays within memory limits.

echo "📦 WAX IPFS Object File Chunking Script"
echo "======================================="
echo ""

# Configuration with defaults
SOURCE_FILE="${SOURCE_OBJECT_FILE:-./object.json}"
COLLECTIONS_PER_CHUNK="${COLLECTIONS_PER_CHUNK:-10}"
OUTPUT_DIR="${CHUNK_OUTPUT_DIR:-./chunks}"
CHUNK_PREFIX="${CHUNK_FILE_PREFIX:-object-chunk}"

# Validation
if [ ! -f "$SOURCE_FILE" ]; then
    echo "❌ ERROR: Source file '$SOURCE_FILE' not found"
    echo "💡 Set SOURCE_OBJECT_FILE environment variable to specify a different file"
    exit 1
fi

if [ "$COLLECTIONS_PER_CHUNK" -lt 1 ]; then
    echo "❌ ERROR: COLLECTIONS_PER_CHUNK must be >= 1"
    exit 1
fi

echo "📋 Configuration:"
echo "  • Source File: $SOURCE_FILE"
echo "  • Collections per chunk: $COLLECTIONS_PER_CHUNK"
echo "  • Output Directory: $OUTPUT_DIR"
echo "  • Chunk File Prefix: $CHUNK_PREFIX"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Check if node is available for JSON processing
if ! command -v node &> /dev/null; then
    echo "❌ ERROR: Node.js is required but not installed"
    echo "💡 Please install Node.js to run this script"
    exit 1
fi

echo "🔄 Processing $SOURCE_FILE..."

# Use Node.js to process the JSON file and create chunks
node -e "
const fs = require('fs');
const path = require('path');

// Read and parse the source file
const sourceFile = '$SOURCE_FILE';
const collectionsPerChunk = parseInt('$COLLECTIONS_PER_CHUNK');
const outputDir = '$OUTPUT_DIR';
const chunkPrefix = '$CHUNK_PREFIX';

try {
    const data = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    
    if (!data.collection || !Array.isArray(data.collection)) {
        console.log('❌ ERROR: Source file must have a \"collection\" array');
        process.exit(1);
    }
    
    const collections = data.collection;
    const tokens = data.token || [];
    const totalCollections = collections.length;
    const totalChunks = Math.ceil(totalCollections / collectionsPerChunk);
    
    console.log(\`📊 Processing \${totalCollections} collections into \${totalChunks} chunks...\`);
    
    // Create chunks
    for (let i = 0; i < totalChunks; i++) {
        const startIndex = i * collectionsPerChunk;
        const endIndex = Math.min(startIndex + collectionsPerChunk, totalCollections);
        const chunkCollections = collections.slice(startIndex, endIndex);
        
        const chunkData = {
            collection: chunkCollections,
            // Only include tokens in the first chunk to avoid duplicate processing
            token: i === 0 ? tokens : []
        };
        
        const chunkNumber = i + 1;
        const chunkFilename = \`\${chunkPrefix}-\${chunkNumber.toString().padStart(2, '0')}.json\`;
        const chunkPath = path.join(outputDir, chunkFilename);
        
        fs.writeFileSync(chunkPath, JSON.stringify(chunkData, null, 2));
        
        const tokenInfo = i === 0 && tokens.length > 0 ? \` + \${tokens.length} tokens\` : '';
        console.log(\`  ✅ \${chunkFilename}: \${chunkCollections.length} collections\${tokenInfo}\`);
    }
    
    console.log(\`\`);
    console.log(\`🎉 Successfully created \${totalChunks} chunk files in \${outputDir}/\`);
    console.log(\`\`);
    console.log(\`📋 Job Configuration:\`);
    for (let i = 1; i <= totalChunks; i++) {
        const chunkNumber = i.toString().padStart(2, '0');
        console.log(\`  • Job \${i}: OBJECT_FILE=\${outputDir}/\${chunkPrefix}-\${chunkNumber}.json\`);
    }
    console.log(\`\`);
    console.log(\`💡 Example usage:\`);
    console.log(\`   OBJECT_FILE=\${outputDir}/\${chunkPrefix}-01.json yarn start\`);
    
} catch (error) {
    console.log(\`❌ ERROR: \${error.message}\`);
    process.exit(1);
}
"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Chunking completed successfully!"
    echo ""
    echo "🔍 Generated files:"
    ls -la "$OUTPUT_DIR"/$CHUNK_PREFIX-*.json | while read -r line; do
        echo "   $line"
    done
    echo ""
    echo "🚀 Next steps:"
    echo "   1. Commit the chunk files to git for tracking"
    echo "   2. Create a separate scheduled job for each chunk file, or use AUTO_CHUNK_MODE=1"
    echo "   3. Set OBJECT_FILE in each job (or CHUNK_DIRECTORY for auto-chunk mode)"
    echo ""
else
    echo "❌ Chunking failed!"
    exit 1
fi